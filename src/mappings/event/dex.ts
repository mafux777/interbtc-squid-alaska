import { SubstrateBlock } from "@subsquid/substrate-processor";
import { Store } from "@subsquid/typeorm-store";
import { 
    CumulativeDexTradeCount,
    CumulativeDexTradeCountPerAccount,
    CumulativeDexTradingVolume,
    CumulativeDexTradingVolumePerAccount,
    CumulativeDexTradingVolumePerPool,
    Currency,
    fromJsonPooledToken,
    PooledToken
} from "../../model";
import { Ctx, EventItem } from "../../processor";
import { DexGeneralAssetSwapEvent, DexStableCurrencyExchangeEvent } from "../../types/events";
import { address, currencyId } from "../encoding";
import { 
    SwapDetails,
    SwapDetailsAmount,
    updateCumulativeDexTotalTradeCount,
    updateCumulativeDexTotalVolumes,
    updateCumulativeDexTradeCountPerAccount,
    updateCumulativeDexVolumesForStablePool,
    updateCumulativeDexVolumesForStandardPool, 
    updateCumulativeDexVolumesPerAccount
} from "../utils/cumulativeVolumes";
import EntityBuffer from "../utils/entityBuffer";
import { getStablePoolCurrencyByIndex } from "../utils/pools";

function isPooledToken(currency: Currency): currency is PooledToken {
    try {
        fromJsonPooledToken(currency);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Combines the given arrays into an array of {@link SwapDetailsAmount}.
 * @param currencies An array of currencies, assumed to be of type {@link PooledToken}
 * @param atomicBalances An array of bigint atomic balances matching the currencies array
 * @returns An array of {@link SwapDetailsAmount}s in the same order as the currencies and amounts were passed in
 * @throws {@link Error}
 * Throws an error if currencies length does not match balances length, or if a passed in currency is not a {@link PooledToken}
 */
function createSwapDetailsAmounts(currencies: Currency[],  atomicBalances: bigint[]): SwapDetailsAmount[] {
    if (currencies.length !== atomicBalances.length) {
        throw new Error(`Cannot create SwapDetailsAmounts; currency count [${
            currencies.length
        }] does not match balance count [${
            atomicBalances.length
        }]`);
    }

    const amounts: SwapDetailsAmount[] = [];

    for (let idx = 0; idx < currencies.length; idx++) {
        const currency = currencies[idx];
        const atomicAmount = atomicBalances[idx];

        if (!isPooledToken(currency)) {
            throw new Error(`Cannot create SwapDetailsAmounts; unexpected currency type found (${
                currency.isTypeOf
            }), skip processing of DexGeneralAssetSwapEvent`);
        }

        amounts.push({
            currency,
            atomicAmount
        });
    }

    return amounts;
}

/**
 * Combines the given arrays into in/out pairs as an array of {@link SwapDetails}.
 * @param amounts The swap details amounts in order of the swap path
 * @returns An array of pair-wise combined {@link SwapDetails}.
 */
function createPairWiseSwapDetails(amounts: SwapDetailsAmount[]): SwapDetails[] {
    const swapDetailsList: SwapDetails[] = [];
    for(let idx = 0; (idx + 1) < amounts.length; idx++) {
        const inIdx = idx;
        const outIdx = idx + 1;
        
        swapDetailsList.push({
            from: amounts[inIdx],
            to: amounts[outIdx]
        });
    }

    return swapDetailsList;
}

async function updateTotalAndPerAccountVolumesAndTradeCounts(
    blockTimestamp: Date,
    amounts: SwapDetailsAmount[],
    accountId: string,
    store: Store,
    entityBuffer: EntityBuffer
): Promise<void> {
    const [
        volumePerAccountEntity,
        totalVolumeEntity,
        tradeCountPerAccountEntity,
        totalCountEntity
    ] = await Promise.all([
        updateCumulativeDexVolumesPerAccount(
            store,
            blockTimestamp,
            amounts,
            accountId,
            entityBuffer
        ),
        updateCumulativeDexTotalVolumes(
            store,
            blockTimestamp,
            amounts,
            entityBuffer
        ),
        updateCumulativeDexTradeCountPerAccount(
            store,
            blockTimestamp,
            accountId,
            entityBuffer
        ),
        updateCumulativeDexTotalTradeCount(
            store,
            blockTimestamp,
            entityBuffer
        ),
    ]);
    entityBuffer.pushEntity(CumulativeDexTradingVolume.name, totalVolumeEntity);
    entityBuffer.pushEntity(CumulativeDexTradingVolumePerAccount.name, volumePerAccountEntity);
    entityBuffer.pushEntity(CumulativeDexTradeCount.name, totalCountEntity);
    entityBuffer.pushEntity(CumulativeDexTradeCountPerAccount.name, tradeCountPerAccountEntity);
}

export async function dexGeneralAssetSwap(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new DexGeneralAssetSwapEvent(ctx, item.event);
    let currencies: Currency[] = [];
    let atomicBalances: bigint[] = [];
    let accountId: string;

    if (rawEvent.isV1021000) {
        const [accountIdRaw, , swapPath, balances] = rawEvent.asV1021000;
        currencies = swapPath.map(currencyId.encode);
        atomicBalances = balances;
        accountId = address.interlay.encode(accountIdRaw);
    } else {
        ctx.log.warn("UNKOWN EVENT VERSION: DexGeneral.AssetSwap");
        return;
    }

    // we can only use pooled tokens, check we have not other ones
    for (const currency of currencies) {
        if (!isPooledToken(currency)) {
            ctx.log.error(`Unexpected currency type ${currency.isTypeOf} in pool, skip processing of DexGeneralAssetSwapEvent`);
            return;
        }
    }

    let amounts: SwapDetailsAmount[];
    try {

        amounts = createSwapDetailsAmounts(currencies, atomicBalances);
    } catch (e) {
        ctx.log.error((e as Error).message);
        return;
    }
    const swapDetailsList = createPairWiseSwapDetails(amounts);


    const blockTimestamp = new Date(block.timestamp);
    // construct and await sequentially, otherwise some operations may try to read values from 
    // the entity buffer before it has been updated
    for (const swapDetails of swapDetailsList) {
        const entity = await updateCumulativeDexVolumesForStandardPool(
            ctx.store,
            blockTimestamp,
            swapDetails,
            entityBuffer
        );
        entityBuffer.pushEntity(CumulativeDexTradingVolumePerPool.name, entity);
    }

    await updateTotalAndPerAccountVolumesAndTradeCounts(
        blockTimestamp,
        amounts,
        accountId,
        ctx.store,
        entityBuffer
    );
}

export async function dexStableCurrencyExchange(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new DexStableCurrencyExchangeEvent(ctx, item.event);
    let poolId: number;
    let inIndex: number;
    let outIndex: number;
    let inAmount: bigint;
    let outAmount: bigint;
    let accountId: string;

    if (rawEvent.isV1021000) {
        const event = rawEvent.asV1021000;
        poolId = event.poolId;
        inIndex = event.inIndex;
        outIndex = event.outIndex;
        inAmount = event.inAmount;
        outAmount = event.outAmount;
        accountId = address.interlay.encode(event.who);
    } else {
        ctx.log.warn("UNKOWN EVENT VERSION: DexStable.CurrencyExchange");
        return;
    }

    const outCurrency = await getStablePoolCurrencyByIndex(ctx, block, poolId, outIndex);
    const inCurrency = await getStablePoolCurrencyByIndex(ctx, block, poolId, inIndex);
    
    if (!isPooledToken(inCurrency)) {
        ctx.log.error(`Unexpected currencyIn type ${inCurrency.isTypeOf}, skip processing of DexGeneralAssetSwapEvent`);
        return;
    }
    if (!isPooledToken(outCurrency)) {
        ctx.log.error(`Unexpected currencyOut type ${outCurrency.isTypeOf}, skip processing of DexGeneralAssetSwapEvent`);
        return;
    }

    const swapDetails: SwapDetails = {
        from: {
            currency: inCurrency,
            atomicAmount: inAmount
        },
        to: {
            currency: outCurrency,
            atomicAmount: outAmount
        }
    };

    const amounts = [swapDetails.from, swapDetails.to];
    const blockTimestamp = new Date(block.timestamp);

    const entity = await updateCumulativeDexVolumesForStablePool(
        ctx.store,
        blockTimestamp,
        poolId,
        swapDetails,
        entityBuffer
    );

    entityBuffer.pushEntity(CumulativeDexTradingVolumePerPool.name, entity);

    await updateTotalAndPerAccountVolumesAndTradeCounts(
        blockTimestamp,
        amounts,
        accountId,
        ctx.store,
        entityBuffer
    );
}