import math
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

import pandas as pd
import streamlit as st
import yfinance as yf


STOCK_SHARES = 100
DEFAULT_RISK_FREE_RATE = 0.03


def normal_cdf(x: float) -> float:
    """Cumulative distribution function for standard normal distribution."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def call_delta(
    spot_price: float,
    strike: float,
    time_to_expiration: float,
    risk_free_rate: float,
    volatility: float,
    dividend_yield: float = 0.0,
) -> float:
    """Approximate Black-Scholes delta for a call option."""
    if spot_price <= 0 or strike <= 0:
        return 0.0
    if time_to_expiration <= 0 or volatility <= 0:
        return 1.0 if spot_price > strike else 0.0
    d1_numerator = math.log(spot_price / strike) + (
        risk_free_rate
        - dividend_yield
        + 0.5 * volatility * volatility
    ) * time_to_expiration
    d1_denominator = volatility * math.sqrt(time_to_expiration)
    d1 = d1_numerator / d1_denominator
    return math.exp(-dividend_yield * time_to_expiration) * normal_cdf(d1)


def is_third_friday(expiry_date: date) -> bool:
    """Return True if the given date is the third Friday of the month."""
    return expiry_date.weekday() == 4 and 15 <= expiry_date.day <= 21


def get_trading_dates(price_history: pd.Series, start: datetime, end: datetime) -> pd.DatetimeIndex:
    mask = (price_history.index >= start) & (price_history.index <= end)
    trading_days = price_history.loc[mask].index
    if trading_days.empty:
        raise ValueError("找不到指定時間範圍內的交易資料，請確認輸入日期。")
    return trading_days


def select_option_row(
    calls: pd.DataFrame,
    spot_price: float,
    delta_target: float,
    expiry_date: datetime,
    risk_free_rate: float,
) -> Optional[pd.Series]:
    if calls.empty:
        return None

    # Remove rows with missing market data
    filtered = calls.dropna(subset=["impliedVolatility", "lastPrice", "strike"])
    if filtered.empty:
        return None

    time_to_expiration = max((expiry_date - datetime.utcnow()).days / 365.0, 1 / 365)

    def compute_delta(row: pd.Series) -> float:
        return call_delta(
            spot_price=spot_price,
            strike=row["strike"],
            time_to_expiration=time_to_expiration,
            risk_free_rate=risk_free_rate,
            volatility=row["impliedVolatility"],
        )

    filtered = filtered.assign(delta=filtered.apply(compute_delta, axis=1))
    filtered["delta_diff"] = (filtered["delta"] - delta_target).abs()
    filtered = filtered.sort_values("delta_diff")
    return filtered.iloc[0]


def build_event(
    event_date: pd.Timestamp,
    cash_change: float = 0.0,
    share_change: int = 0,
    description: str = "",
    metadata: Optional[Dict[str, float]] = None,
) -> Dict:
    return {
        "date": event_date,
        "cash": cash_change,
        "shares": share_change,
        "description": description,
        "metadata": metadata or {},
    }


def run_simulation(
    ticker_symbol: str,
    start: datetime,
    end: datetime,
    delta_target: float,
    option_frequency: str,
    risk_free_rate: float,
) -> Dict[str, pd.DataFrame]:
    ticker = yf.Ticker(ticker_symbol)
    history = ticker.history(start=start - timedelta(days=60), end=end + timedelta(days=1))
    if history.empty:
        raise ValueError("無法取得股票歷史資料，請確認代碼是否正確。")

    closes = history["Close"]
    trading_dates = get_trading_dates(closes, start, end)
    first_trade_date = trading_dates[0]
    first_price = closes.loc[first_trade_date]

    events: List[Dict] = []
    events.append(
        build_event(
            event_date=first_trade_date,
            cash_change=-first_price * STOCK_SHARES,
            share_change=STOCK_SHARES,
            description=f"以 {first_price:.2f} 美元買入 {STOCK_SHARES} 股",
        )
    )

    current_sell_date = first_trade_date
    option_dates = []
    for expiry_str in ticker.options:
        try:
            expiry = datetime.strptime(expiry_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if option_frequency == "monthly" and not is_third_friday(expiry):
            continue
        option_dates.append(datetime.combine(expiry, datetime.min.time()))
    option_dates.sort()

    for expiry in option_dates:
        if expiry.date() <= current_sell_date.date():
            continue
        if expiry > end:
            break

        try:
            option_chain = ticker.option_chain(expiry.strftime("%Y-%m-%d"))
        except Exception:
            continue

        spot_price = closes.loc[current_sell_date]
        call_row = select_option_row(
            calls=option_chain.calls,
            spot_price=spot_price,
            delta_target=delta_target,
            expiry_date=expiry,
            risk_free_rate=risk_free_rate,
        )
        if call_row is None or pd.isna(call_row.get("lastPrice", math.nan)):
            continue

        premium = float(call_row["lastPrice"])
        strike = float(call_row["strike"])
        delta = float(call_row.get("delta", float("nan")))

        events.append(
            build_event(
                event_date=current_sell_date,
                cash_change=premium * STOCK_SHARES,
                description=(
                    f"賣出履約價 {strike:.2f}、Delta 約為 {delta:.2f} 的 covered call，" f"收取權利金 {premium:.2f}"
                ),
                metadata={"strike": strike, "delta": delta, "premium": premium},
            )
        )

        expiry_trade_days = closes.loc[(closes.index <= expiry) & (closes.index >= current_sell_date)]
        if expiry_trade_days.empty:
            continue
        expiry_trade_date = expiry_trade_days.index[-1]
        expiry_price = closes.loc[expiry_trade_date]

        if expiry_price > strike:
            events.append(
                build_event(
                    event_date=expiry_trade_date,
                    cash_change=strike * STOCK_SHARES,
                    share_change=-STOCK_SHARES,
                    description=(
                        f"到期價 {expiry_price:.2f} 高於履約價 {strike:.2f}，被指派賣出股票"
                    ),
                    metadata={"strike": strike},
                )
            )

            future_dates = trading_dates[trading_dates > expiry_trade_date]
            if future_dates.empty:
                current_sell_date = expiry_trade_date
                break
            next_trade_date = future_dates[0]
            if next_trade_date > end:
                current_sell_date = expiry_trade_date
                break
            next_price = closes.loc[next_trade_date]
            events.append(
                build_event(
                    event_date=next_trade_date,
                    cash_change=-next_price * STOCK_SHARES,
                    share_change=STOCK_SHARES,
                    description=f"以 {next_price:.2f} 美元買回股票 {STOCK_SHARES} 股",
                )
            )
            current_sell_date = next_trade_date
        else:
            current_sell_date = expiry_trade_date

    events.sort(key=lambda e: e["date"])

    cash = 0.0
    shares = 0
    values = []
    event_idx = 0
    for trading_date in trading_dates:
        while event_idx < len(events) and events[event_idx]["date"] <= trading_date:
            event = events[event_idx]
            cash += event["cash"]
            shares += event["shares"]
            event_idx += 1
        total_value = cash + shares * closes.loc[trading_date]
        values.append({"date": trading_date, "Covered Call": total_value})

    covered_df = pd.DataFrame(values).set_index("date")

    hold_values = []
    hold_cash = -first_price * STOCK_SHARES
    for trading_date in trading_dates:
        hold_total = hold_cash + STOCK_SHARES * closes.loc[trading_date]
        hold_values.append({"date": trading_date, "Buy & Hold": hold_total})
    hold_df = pd.DataFrame(hold_values).set_index("date")

    event_df = pd.DataFrame(events)
    if not event_df.empty:
        event_df["date"] = event_df["date"].dt.tz_localize(None)

    summary = pd.DataFrame(
        {
            "策略": ["Covered Call", "Buy & Hold"],
            "最終資產": [
                covered_df.iloc[-1]["Covered Call"],
                hold_df.iloc[-1]["Buy & Hold"],
            ],
        }
    )

    return {
        "covered": covered_df,
        "hold": hold_df,
        "events": event_df,
        "summary": summary,
    }


def main() -> None:
    st.set_page_config(page_title="Covered Call 模擬器", layout="wide")
    st.title("Covered Call 與持股策略比較")

    st.sidebar.header("參數設定")
    ticker_symbol = st.sidebar.text_input("美股股票代碼", value="AAPL")
    start_date = st.sidebar.date_input("開始日期", value=date.today() - timedelta(days=365))
    end_date = st.sidebar.date_input("結束日期", value=date.today())
    if start_date >= end_date:
        st.error("結束日期必須晚於開始日期")
        return

    delta_target = st.sidebar.slider("目標 Delta", min_value=0.1, max_value=0.8, value=0.3, step=0.05)
    option_frequency = st.sidebar.selectbox("期權週期", options=["weekly", "monthly"], format_func=lambda x: "週選" if x == "weekly" else "月選")
    risk_free_rate = st.sidebar.number_input("無風險利率 (年化)", value=DEFAULT_RISK_FREE_RATE, step=0.01)

    run_button = st.sidebar.button("開始模擬")

    if not run_button:
        st.info("請在左側輸入參數並開始模擬。")
        return

    with st.spinner("下載資料並執行策略模擬中..."):
        try:
            result = run_simulation(
                ticker_symbol=ticker_symbol,
                start=datetime.combine(start_date, datetime.min.time()),
                end=datetime.combine(end_date, datetime.min.time()),
                delta_target=delta_target,
                option_frequency=option_frequency,
                risk_free_rate=risk_free_rate,
            )
        except Exception as exc:  # pylint: disable=broad-exception-caught
            st.error(f"模擬過程發生錯誤：{exc}")
            return

    covered_df = result["covered"]
    hold_df = result["hold"]
    combined_df = covered_df.join(hold_df, how="outer")

    st.subheader("資產價值比較")
    st.line_chart(combined_df)

    st.subheader("最終資產比較")
    st.dataframe(result["summary"], hide_index=True)

    st.subheader("交易事件紀錄")
    if result["events"].empty:
        st.write("在指定期間內沒有完成任何期權交易。")
    else:
        event_table = result["events"].copy()
        event_table["cash"] = event_table["cash"].round(2)
        event_table["description"] = event_table["description"].astype(str)
        st.dataframe(event_table.drop(columns=["metadata"]), hide_index=True)

    st.caption("資料來源：Yahoo Finance (透過 yfinance 套件)")


if __name__ == "__main__":
    main()