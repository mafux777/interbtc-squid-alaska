import { Deposit, Loan, LoanMarket, LoanMarketActivation, MarketState } from "../../model";
import { SubstrateBlock, toHex } from "@subsquid/substrate-processor";
import { LessThanOrEqual } from "typeorm";
import {
    CumulativeVolume,
    CumulativeVolumePerCurrencyPair,
    LendToken,
    InterestAccrual,
    Redeem,
    RedeemCancellation,
    RedeemExecution,
    RedeemPeriod,
    RedeemRequest,
    RedeemStatus,
    RelayedBlock,
    Transfer,
    VolumeType,
} from "../../model";
import { Ctx, EventItem } from "../../processor";
import {
    LoansActivatedMarketEvent,
    LoansBorrowedEvent,
    LoansDepositCollateralEvent,
    LoansDepositedEvent,
    LoansDistributedBorrowerRewardEvent,
    LoansDistributedSupplierRewardEvent,
    LoansInterestAccruedEvent,
    LoansLiquidatedBorrowEvent,
    LoansNewMarketEvent,
    LoansRedeemedEvent,
    LoansRepaidBorrowEvent,
    LoansUpdatedMarketEvent,
    LoansWithdrawCollateralEvent
} from "../../types/events";

import {
    CurrencyId as CurrencyId_V1020000,
    CurrencyId_LendToken,
    Market as LoanMarket_V1020000
} from "../../types/v1020000";

import { CurrencyId as CurrencyId_V1021000,
    Market as LoanMarket_V1021000
} from "../../types/v1021000";

import EntityBuffer from "../utils/entityBuffer";
import { blockToHeight } from "../utils/heights";
import { friendlyAmount, getFirstAndLastFour, symbolFromCurrency, getExchangeRate } from "../_utils";
import { lendTokenDetails } from "../utils/markets";

import { CurrencyId_Token as CurrencyId_Token_V6 } from "../../types/v6";
import { CurrencyId_Token as CurrencyId_Token_V10 } from "../../types/v10";
import { CurrencyId_Token as CurrencyId_Token_V15 } from "../../types/v15";
import { CurrencyId as CurrencyId_V17 } from "../../types/v17";
import { InterestRateModel as InterestRateModel_V1020000 } from "../../types/v1020000";
import { address, currencyId, currencyToString, legacyCurrencyId, rateModel } from "../encoding";
import {
    updateCumulativeVolumes,
    updateCumulativeVolumesForCurrencyPair,
} from "../utils/cumulativeVolumes";
import { getCurrentRedeemPeriod } from "../utils/requestPeriods";
import { getVaultId, getVaultIdLegacy } from "../_utils";
import {Currency} from "../../model/generated/_currency"
import { number } from "bitcoinjs-lib/types/script";
import { storeMainChainHeader } from "./btcRelay";

type Rate = {
    block: number;
    symbol: string;
    rate: number;
};

class BlockRates {
    rates: Rate[] = [];

    addRate(block: number, symbol: string, rate: number) {
        this.rates.push({ block, symbol, rate });
    }

    getRate(block: number, symbol: string): Rate {
        for (let i = this.rates.length - 1; i >= 0; i--) {
            if (this.rates[i].symbol === symbol) {
                if (this.rates[i].block <= block) {
                    return this.rates[i];
                }
            }
        }
        console.log(`Returning default rate for ${symbol}`);
        return {block: block, symbol: symbol, rate: 0.02};
    }
}

class CachedRates {
    private cache = new Map<number, Map<string, number>>();

    add(entry: Rate) {
        if (!this.cache.has(entry.block)) {
            this.cache.set(entry.block, new Map([[entry.symbol, entry.rate]]));
            return;
        }
        this.cache.get(entry.block)!.set(entry.symbol, entry.rate);
    }

    get(block: number, symbol: string): number | undefined {
        const blockRates = this.cache.get(block);
        return blockRates ? blockRates.get(symbol) : undefined;
    }

    clear() {
        this.cache.clear();
    }
}

const cachedRates = new BlockRates();

// async function latestExchangeRate(
//     ctx: Ctx,
//     block: SubstrateBlock,
// ) : Promise<ExRate> {
//     const testEntity = {id: 0,
//         symbol: "ESP"
//     }
//     const interestAccrued = rateCache.pushEntity("ExRate", testEntity)
//     // const interestAccrued = await ctx.store.get(InterestAccrual, {
//     //     //where: { height : { absolute : LessThanOrEqual(block.height) } },
//     //     //order: { height : { absolute: "DESC"} },
//     //     where: { timestamp : LessThanOrEqual(Date.now()) },
//     //     order: { timestamp : "DESC" },
//     // })
//     const exRate: ExRate = Object.assign({}, {
//         symbol: interestAccrued?.currencySymbol ?? '',
//         rate: interestAccrued?.exchangeRateFloat ?? 0,
//         activeBlock: interestAccrued?.height.active ?? 0
//     });
//     return exRate;
// }

export async function newMarket(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansNewMarketEvent(ctx, item.event);
    let e;
    let underlyingCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let market: LoanMarket_V1020000|LoanMarket_V1021000;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ underlyingCurrencyId, market ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        underlyingCurrencyId = e.underlyingCurrencyId;
        market = e.market;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansNewMarketEvent`);
        return;
    }

    const currency = currencyId.encode(underlyingCurrencyId);
    const id = currencyToString(currency);
    const InterestRateModel = rateModel.encode(market.rateModel)

    const height = await blockToHeight(ctx, block.height, "NewMarket");
    const timestamp = new Date(block.timestamp);
    const lendTokenIdNo = (market.lendTokenId as CurrencyId_LendToken).value;

    const my_market = new LoanMarket({
        id: `loanMarket_` + id, //lendTokenId.toString(),
        token: currency,
        height: height,
        timestamp: timestamp,
        borrowCap: market.borrowCap,
        supplyCap: market.supplyCap,
        rateModel: InterestRateModel,
        closeFactor: market.closeFactor,
        lendTokenId: lendTokenIdNo,
        state: MarketState.Pending,
        reserveFactor: market.reserveFactor,
        collateralFactor: market.collateralFactor,
        liquidateIncentive: market.liquidateIncentive,
        liquidationThreshold: market.liquidationThreshold,
        liquidateIncentiveReservedFactor: market.liquidateIncentiveReservedFactor
    });
    // console.log(JSON.stringify(my_market));
    await entityBuffer.pushEntity(LoanMarket.name, my_market);
}

// Updated market just adds new market with same id (replacing newMarket)
export async function updatedMarket(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansUpdatedMarketEvent(ctx, item.event);
    let e;
    let underlyingCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let market: LoanMarket_V1020000|LoanMarket_V1021000;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ underlyingCurrencyId, market ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        underlyingCurrencyId = e.underlyingCurrencyId;
        market = e.market;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansUpdatedMarketEvent`);
        return;
    }

    const currency = currencyId.encode(underlyingCurrencyId);
    const id = currencyToString(currency);
    const InterestRateModel = rateModel.encode(market.rateModel)

    const height = await blockToHeight(ctx, block.height, "UpdatedMarket");
    const timestamp = new Date(block.timestamp);
    const lendTokenIdNo = (market.lendTokenId as CurrencyId_LendToken).value;

    const my_market = new LoanMarket({
        id: `loanMarket_` + id, //lendTokenId.toString(),
        token: currency,
        height: height,
        timestamp: timestamp,
        borrowCap: market.borrowCap,
        supplyCap: market.supplyCap,
        rateModel: InterestRateModel,
        closeFactor: market.closeFactor,
        lendTokenId: lendTokenIdNo,
        reserveFactor: market.reserveFactor,
        collateralFactor: market.collateralFactor,
        liquidateIncentive: market.liquidateIncentive,
        liquidationThreshold: market.liquidationThreshold,
        liquidateIncentiveReservedFactor: market.liquidateIncentiveReservedFactor
    });

    my_market.state =
        market.state.__kind === "Supervision"
            ? MarketState.Supervision
            : MarketState.Pending;

    // console.log(JSON.stringify(my_market));
    await entityBuffer.pushEntity(LoanMarket.name, my_market);

    console.log(`Updated ${my_market.id}`);
}

export async function activatedMarket(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansActivatedMarketEvent(ctx, item.event);
    let e;
    let underlyingCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    if (rawEvent.isV1020000) {
        underlyingCurrencyId = rawEvent.asV1020000;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        underlyingCurrencyId = e.underlyingCurrencyId;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansActivatedMarketEvent`);
        return;
    }

    const currency = currencyId.encode(underlyingCurrencyId);
    const id = currencyToString(currency);

    const marketDb = await ctx.store.get(LoanMarket, {
        where: { id: `loanMarket_${id}` },
    });
    if (marketDb === undefined) {
        ctx.log.warn(
            "WARNING: ActivatedMarket event did not match any existing LoanMarkets! Skipping."
        );
        return;
    }
    const height = await blockToHeight(ctx, block.height, "ActivatedMarket");
    const activation = new LoanMarketActivation({
        id: marketDb.id,
        market: marketDb,
        token: currency,
        height,
        timestamp: new Date(block.timestamp),
    });
    marketDb.state = MarketState.Active
    marketDb.activation = activation;
    await entityBuffer.pushEntity(LoanMarketActivation.name, activation);
    await entityBuffer.pushEntity(LoanMarket.name, marketDb);

    console.log(`Activated ${marketDb.id}`);
}

export async function borrow(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansBorrowedEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansBorrowedEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "LoansBorrowed");
    const account = address.interlay.encode(accountId);
    
    let rates = await getExchangeRate(ctx, block.timestamp, currency, amount);
    const amountFriendly = await friendlyAmount(currency, Number(amount));
    const amountFiat = rates.usdt * Number(amount);
    const amountBtc = rates.btc * Number(amount);

    const comment = `${getFirstAndLastFour(account)} borrowed ${amountFriendly} at fiat value $${amountFiat}`;
    
    await entityBuffer.pushEntity(
        Loan.name,
        new Loan({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountBorrowed: amount,
            comment: comment
        })
    );
}

export async function depositCollateral(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansDepositCollateralEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansDepositCollateralEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "Deposit");
    const account = address.interlay.encode(accountId);
    let comment;
    let exRate;
    if(currency.isTypeOf==='LendToken'){
        const newToken = await lendTokenDetails(ctx, currency.lendTokenId);
        const newTokenSymbol = await symbolFromCurrency(newToken!);
        exRate = cachedRates.getRate(block.height, newTokenSymbol);
        console.log(`${block.height-exRate.block} blocks difference for ${exRate.symbol}` )
        const newAmount = Number(amount) * exRate.rate;
        if(newToken){
            comment = `${getFirstAndLastFour(account)} deposited ${await friendlyAmount(newToken, newAmount)} for collateral`
        }
    } else {
        comment = `${getFirstAndLastFour(account)} deposited ${await friendlyAmount(currency, Number(amount))} for collateral`
    }
    await entityBuffer.pushEntity(
        Deposit.name,
        new Deposit({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountDeposited: amount,
            comment: comment
        })
    );
}

export async function withdrawCollateral(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansWithdrawCollateralEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansDepositCollateralEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "WithdrawDeposit");
    const account = address.interlay.encode(accountId);
    let exRate: Rate | undefined;
    let comment ='';
    if(currency.isTypeOf==='LendToken'){
        const newToken = await lendTokenDetails(ctx, currency.lendTokenId)
        const newTokenSymbol = await symbolFromCurrency(newToken!);
        exRate = cachedRates.getRate(block.height, newTokenSymbol);
        console.log(`${block.height-exRate.block} blocks difference for ${exRate.symbol}` )
        const newAmount = Number(amount) * exRate!.rate;
        if(newToken){
            comment = `${getFirstAndLastFour(account)} withdrew ${await friendlyAmount(newToken, newAmount)} from collateral`;
        }
    } else {
        comment = `${getFirstAndLastFour(account)} withdrew ${await friendlyAmount(currency, Number(amount))} from collateral`;
    }
    await entityBuffer.pushEntity(
        Deposit.name,
        new Deposit({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountWithdrawn: amount,
            comment: comment
        })
    );
}

export async function depositForLending(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansDepositedEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansDepositedEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "Deposit");
    const account = address.interlay.encode(accountId);
    const comment = `${getFirstAndLastFour(account)} deposited ${await friendlyAmount(currency, Number(amount))} for lending`;
    await entityBuffer.pushEntity(
        Deposit.name,
        new Deposit({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountDeposited: amount,
            comment: comment
        })
    );
}

export async function distributeBorrowerReward(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansDistributedBorrowerRewardEvent(ctx, item.event);
}

export async function distributeSupplierReward(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansDistributedSupplierRewardEvent(ctx, item.event);
}

export async function repay(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansRepaidBorrowEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansRepaidBorrowEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "LoansRepaid");
    const account = address.interlay.encode(accountId);
    const comment = `${getFirstAndLastFour(account)} paid back ${await friendlyAmount(currency, Number(amount))}`
    await entityBuffer.pushEntity(
        Loan.name,
        new Loan({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountRepaid: amount,
            comment: comment
        })
    );
}

"Redeem means withdrawing a deposit by redeeming qTokens for Tokens."
export async function withdrawDeposit(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansRedeemedEvent(ctx, item.event);
    let accountId: Uint8Array;
    let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    let amount: bigint;
    let e;
    if (rawEvent.isV1020000) {
        e = rawEvent.asV1020000;
        [ accountId, myCurrencyId, amount ] = e;
    }
    else if (rawEvent.isV1021000) {
        e = rawEvent.asV1021000;
        accountId = e.accountId;
        myCurrencyId = e.currencyId;
        amount = e.amount;
    }
    else {
        ctx.log.warn(`UNKOWN EVENT VERSION: LoansRepaidBorrowEvent`);
        return;
    }
    const currency = currencyId.encode(myCurrencyId);
    const height = await blockToHeight(ctx, block.height, "Redeemed");
    const account = address.interlay.encode(accountId);
    const comment = `${getFirstAndLastFour(account)} withdrew ${await friendlyAmount(currency, Number(amount))} from deposit`;
    await entityBuffer.pushEntity(
        Deposit.name,
        new Deposit({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            userParachainAddress: account,
            token: currency,
            amountWithdrawn: amount,
            comment: comment// expand to 3 tokens: qToken, Token, equivalent in USD(T)
        })
    );
}

"Redeem means withdrawing a deposit by redeeming qTokens for Tokens."
export async function liquidateLoan(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansLiquidatedBorrowEvent(ctx, item.event);
    // {liquidator: Uint8Array,
    // borrower: Uint8Array,
    // liquidationCurrencyId: v1021000.CurrencyId,
    // collateralCurrencyId: v1021000.CurrencyId,
    // repayAmount: bigint,
    // collateralUnderlyingAmount: bigint}
    // let accountId: Uint8Array;
    // let myCurrencyId: CurrencyId_V1020000|CurrencyId_V1021000;
    // let amount: bigint;
    // let e;
    // if (rawEvent.isV1020000) {
    //     e = rawEvent.asV1020000;
    //     [ accountId, myCurrencyId, amount ] = e;
    // }
    // else if (rawEvent.isV1021000) {
    //     e = rawEvent.asV1021000;
    //     accountId = e.accountId;
    //     myCurrencyId = e.currencyId;
    //     amount = e.amount;
    // }
    // else {
    //     ctx.log.warn(`UNKOWN EVENT VERSION: LoansRepaidBorrowEvent`);
    //     return;
    // }
    // const currency = currencyId.encode(myCurrencyId);
    // const height = await blockToHeight(ctx, block.height, "Redeemed");
    // const account = address.interlay.encode(accountId);
    // const comment = `${getFirstAndLastFour(account)} withdrew ${await friendlyAmount(currency, Number(amount))} from deposit`;
    // await entityBuffer.pushEntity(
    //     Deposit.name,
    //     new Deposit({
    //         id: item.event.id,
    //         height: height,
    //         timestamp: new Date(block.timestamp),
    //         userParachainAddress: account,
    //         token: currency,
    //         amountWithdrawn: amount,
    //         comment: comment// expand to 3 tokens: qToken, Token, equivalent in USD(T)
    //     })
    // );
}

"Whenever a loan is taken or repaid, interest is accrued by slightly changing the exchange rate"
export async function accrueInterest(
    ctx: Ctx,
    block: SubstrateBlock,
    item: EventItem,
    entityBuffer: EntityBuffer
): Promise<void> {
    const rawEvent = new LoansInterestAccruedEvent(ctx, item.event);
    const interestAccrued = rawEvent.asV1021000;
    const { exchangeRate: exchangeRate} = interestAccrued;
    const ex = Number(exchangeRate) / 10 ** 18;

    const currency = currencyId.encode(interestAccrued.underlyingCurrencyId);
    const height = await blockToHeight(ctx, block.height, "Interest Accrued");
    const symbol = await symbolFromCurrency(currency);
    cachedRates.addRate(
        block.height,
        symbol,
        ex,
    );

    await entityBuffer.pushEntity(
        InterestAccrual.name,
        new InterestAccrual({
            id: item.event.id,
            height: height,
            timestamp: new Date(block.timestamp),
            underlyingCurrency: currency,
            currencySymbol: symbol,
            totalBorrows: interestAccrued.totalBorrows,
            totalReserves: interestAccrued.totalReserves,
            borrowIndex: interestAccrued.borrowIndex,
            utilizationRatio: interestAccrued.utilizationRatio,
            borrowRate: interestAccrued.borrowRate,
            supplyRate: interestAccrued.supplyRate,
            exchangeRate: interestAccrued.exchangeRate,
            exchangeRateFloat: ex,
            comment: `Exchange rate for ${symbol} now ${ex}`
        })
    );
}

