const STOCK_SHARES = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const statusEl = document.getElementById("status");
const form = document.getElementById("control-form");
const deltaRange = document.getElementById("delta");
const deltaValue = document.getElementById("delta-value");
const runButton = document.getElementById("run-button");
const summaryBody = document.querySelector("#summary-table tbody");
const eventsBody = document.querySelector("#events-table tbody");

let equityChart;

function formatDateInputValue(date) {
  const tzAdjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return tzAdjusted.toISOString().slice(0, 10);
}

function initDateInputs() {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * MS_PER_DAY);
  document.getElementById("start-date").value = formatDateInputValue(start);
  document.getElementById("end-date").value = formatDateInputValue(end);
}

function formatUSD(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function erf(x) {
  // Abramowitz and Stegun formula 7.1.26 approximation
  const sign = Math.sign(x);
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const polynomial = coefficients.reduce((acc, coeff) => acc * t + coeff, 0);
  const approx = 1 - polynomial * Math.exp(-absX * absX);
  return sign * approx;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function callDelta({
  spotPrice,
  strike,
  timeToExpiration,
  riskFreeRate,
  volatility,
  dividendYield = 0,
}) {
  if (spotPrice <= 0 || strike <= 0) return 0;
  if (timeToExpiration <= 0 || volatility <= 0) {
    return spotPrice > strike ? 1 : 0;
  }
  const logTerm = Math.log(spotPrice / strike);
  const drift = riskFreeRate - dividendYield + 0.5 * volatility * volatility;
  const numerator = logTerm + drift * timeToExpiration;
  const denominator = volatility * Math.sqrt(timeToExpiration);
  const d1 = numerator / denominator;
  return Math.exp(-dividendYield * timeToExpiration) * normalCdf(d1);
}

function isThirdFriday(date) {
  return date.getUTCDay() === 5 && date.getUTCDate() >= 15 && date.getUTCDate() <= 21;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchWithFallback(urls, { description, connectionErrorMessage, requestInit }) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store", mode: "cors", ...requestInit });
      if (!response.ok) {
        lastError = new Error(`${description} 回應狀態 ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      console.warn(`${description} 來源 ${url} 失敗`, error);
      lastError = error;
    }
  }
  console.error(`${description} 取得失敗`, lastError);
  throw new Error(connectionErrorMessage);
}

async function fetchPriceHistory(symbol, startDate, endDate) {
  const startSeconds = Math.floor(startDate.getTime() / 1000);
  const endSeconds = Math.floor((endDate.getTime() + MS_PER_DAY) / 1000);
  const urlParams = new URLSearchParams({
    interval: "1d",
    period1: String(startSeconds),
    period2: String(endSeconds),
    includePrePost: "false",
    events: "div,split",
  });
  const baseUrls = [
    "https://query1.finance.yahoo.com/v8/finance/chart/",
    "https://query2.finance.yahoo.com/v8/finance/chart/",
  ];
  const payload = await fetchWithFallback(
    baseUrls.map((base) => `${base}${encodeURIComponent(symbol)}?${urlParams.toString()}`),
    {
      description: "股價資料",
      connectionErrorMessage: "無法連線至 Yahoo Finance（股價資料）",
    }
  );
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const adjClose = result?.indicators?.adjclose?.[0]?.adjclose;
  const close = result?.indicators?.quote?.[0]?.close;
  if (!result || !Array.isArray(timestamps)) {
    throw new Error("股價資料格式不正確");
  }
  const records = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i];
    const price = adjClose?.[i] ?? close?.[i];
    if (!(Number.isFinite(ts) && Number.isFinite(price))) {
      continue;
    }
    const date = new Date(ts * 1000);
    const key = dateKey(date);
    records.push({ date, close: Number(price), key });
  }
  records.sort((a, b) => a.date - b.date);
  return records;
}

async function fetchOptionMetadata(symbol) {
  const urlTemplates = [
    "https://query2.finance.yahoo.com/v7/finance/options/",
    "https://query1.finance.yahoo.com/v7/finance/options/",
  ];
  const payload = await fetchWithFallback(
    urlTemplates.map((base) => `${base}${encodeURIComponent(symbol)}`),
    {
      description: "期權基本資料",
      connectionErrorMessage: "無法連線至 Yahoo Finance（期權基本資料）",
    }
  );
  const optionData = payload?.optionChain?.result?.[0];
  if (!optionData || !optionData.expirationDates) {
    throw new Error("期權資料格式不正確");
  }
  return optionData.expirationDates.map((ts) => new Date(ts * 1000));
}

async function fetchOptionChain(symbol, expiration) {
  const timestamp = Math.floor(expiration.getTime() / 1000);
  const urlTemplates = [
    "https://query2.finance.yahoo.com/v7/finance/options/",
    "https://query1.finance.yahoo.com/v7/finance/options/",
  ];
  const payload = await fetchWithFallback(
    urlTemplates.map(
      (base) => `${base}${encodeURIComponent(symbol)}?date=${timestamp}`
    ),
    {
      description: `${formatDate(expiration)} 期權鏈`,
      connectionErrorMessage: `無法連線至 Yahoo Finance（${formatDate(expiration)} 期權鏈）`,
    }
  );
  const optionData = payload?.optionChain?.result?.[0];
  return optionData ? optionData.calls ?? [] : [];
}

function selectOptionRow({ calls, spotPrice, deltaTarget, expiryDate, riskFreeRate, valuationDate }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return null;
  }
  const timeToExpiration = Math.max(
    (expiryDate.getTime() - valuationDate.getTime()) / (365 * MS_PER_DAY),
    1 / 365
  );
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const call of calls) {
    const strike = Number(call.strike);
    const premium = Number(call.lastPrice ?? call.bid ?? 0);
    const volatility = Number(call.impliedVolatility ?? 0);
    if (!(strike > 0 && premium > 0 && volatility > 0)) {
      continue;
    }
    const delta = callDelta({
      spotPrice,
      strike,
      timeToExpiration,
      riskFreeRate,
      volatility,
    });
    const diff = Math.abs(delta - deltaTarget);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { strike, premium, delta };
    }
  }
  return best;
}

function getLastTradingDayBefore(tradingDays, targetDate) {
  let candidate = null;
  for (const day of tradingDays) {
    if (day.date <= targetDate) {
      candidate = day;
    } else {
      break;
    }
  }
  return candidate;
}

function buildEvent({ date, cash = 0, shares = 0, description = "" }) {
  return { date, cash, shares, description };
}

function computeEquityCurves({ tradingDays, events }) {
  const orderedEvents = [...events].sort((a, b) => a.date - b.date);
  const coveredSeries = [];
  let eventIndex = 0;
  let cash = 0;
  let shares = 0;

  for (const day of tradingDays) {
    while (eventIndex < orderedEvents.length && orderedEvents[eventIndex].date <= day.date) {
      const event = orderedEvents[eventIndex];
      cash += event.cash;
      shares += event.shares;
      eventIndex += 1;
    }
    coveredSeries.push({ date: day.date, value: cash + shares * day.close });
  }
  return coveredSeries;
}

function computeHoldCurve({ tradingDays, firstPrice }) {
  const holdSeries = [];
  const initialCash = -firstPrice * STOCK_SHARES;
  for (const day of tradingDays) {
    holdSeries.push({ date: day.date, value: initialCash + STOCK_SHARES * day.close });
  }
  return holdSeries;
}

function renderChart({ covered, hold }) {
  const ctx = document.getElementById("equity-chart").getContext("2d");
  const labels = covered.map((point) => formatDate(point.date));
  const coveredData = covered.map((point) => Number(point.value.toFixed(2)));
  const holdData = hold.map((point) => Number(point.value.toFixed(2)));

  if (equityChart) {
    equityChart.destroy();
  }

  equityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Covered Call",
          data: coveredData,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.15)",
          tension: 0.25,
        },
        {
          label: "Buy & Hold",
          data: holdData,
          borderColor: "#64748b",
          backgroundColor: "rgba(100, 116, 139, 0.1)",
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
        },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.parsed.y;
              return `${context.dataset.label}: ${formatUSD(value)}`;
            },
          },
        },
      },
      scales: {
        y: {
          ticks: {
            callback(value) {
              return formatUSD(value);
            },
          },
        },
      },
    },
  });
}

function renderSummary(rows) {
  summaryBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = row.name;
    const valueCell = document.createElement("td");
    valueCell.textContent = formatUSD(row.value);
    tr.appendChild(nameCell);
    tr.appendChild(valueCell);
    summaryBody.appendChild(tr);
  }
}

function renderEvents(events) {
  eventsBody.innerHTML = "";
  if (events.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "在指定期間內沒有完成任何期權交易。";
    tr.appendChild(td);
    eventsBody.appendChild(tr);
    return;
  }
  for (const event of events) {
    const tr = document.createElement("tr");
    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(event.date);
    const cashCell = document.createElement("td");
    cashCell.textContent = formatUSD(event.cash);
    const shareCell = document.createElement("td");
    shareCell.textContent = event.shares.toString();
    const descriptionCell = document.createElement("td");
    descriptionCell.textContent = event.description;
    tr.appendChild(dateCell);
    tr.appendChild(cashCell);
    tr.appendChild(shareCell);
    tr.appendChild(descriptionCell);
    eventsBody.appendChild(tr);
  }
}

function validateDates(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) {
    throw new Error("日期格式不正確");
  }
  if (start >= end) {
    throw new Error("結束日期必須晚於開始日期");
  }
}

async function runSimulation({ symbol, startDate, endDate, deltaTarget, frequency, riskFreeRate }) {
  const priceHistory = await fetchPriceHistory(symbol, startDate, endDate);
  const tradingDays = priceHistory.filter((record) => record.date >= startDate && record.date <= endDate);
  if (tradingDays.length === 0) {
    throw new Error("找不到指定時間範圍內的交易資料");
  }
  const priceByKey = new Map(tradingDays.map((record) => [record.key, record]));
  const firstTrade = tradingDays[0];
  const events = [
    buildEvent({
      date: firstTrade.date,
      cash: -firstTrade.close * STOCK_SHARES,
      shares: STOCK_SHARES,
      description: `以 ${firstTrade.close.toFixed(2)} 美元買入 ${STOCK_SHARES} 股`,
    }),
  ];

  let currentSellDate = firstTrade.date;
  const expirationDates = await fetchOptionMetadata(symbol);

  for (const expiry of expirationDates) {
    if (expiry <= currentSellDate) continue;
    if (expiry > endDate) break;
    if (frequency === "monthly" && !isThirdFriday(expiry)) continue;

    let optionChain;
    try {
      optionChain = await fetchOptionChain(symbol, expiry);
    } catch (error) {
      console.warn(`取得 ${formatDate(expiry)} 期權資料失敗`, error);
      continue;
    }
    if (!optionChain || optionChain.length === 0) continue;

    const valuationKey = dateKey(currentSellDate);
    const valuationRecord = priceByKey.get(valuationKey);
    const spotPrice = valuationRecord ? valuationRecord.close : null;
    if (!spotPrice) continue;

    const option = selectOptionRow({
      calls: optionChain,
      spotPrice,
      deltaTarget,
      expiryDate: expiry,
      riskFreeRate,
      valuationDate: currentSellDate,
    });
    if (!option) continue;

    events.push(
      buildEvent({
        date: currentSellDate,
        cash: option.premium * STOCK_SHARES,
        description: `賣出履約價 ${option.strike.toFixed(2)}、Delta 約 ${option.delta.toFixed(2)} 的 covered call，收取權利金 ${option.premium.toFixed(2)}`,
      })
    );

    const expiryTrade = getLastTradingDayBefore(tradingDays, expiry);
    if (!expiryTrade) continue;

    const expiryPrice = expiryTrade.close;
    if (expiryPrice > option.strike) {
      events.push(
        buildEvent({
          date: expiryTrade.date,
          cash: option.strike * STOCK_SHARES,
          shares: -STOCK_SHARES,
          description: `到期價 ${expiryPrice.toFixed(2)} 高於履約價 ${option.strike.toFixed(2)}，被指派賣出股票`,
        })
      );

      const futureDates = tradingDays.filter((record) => record.date > expiryTrade.date);
      if (futureDates.length === 0) {
        currentSellDate = expiryTrade.date;
        break;
      }
      const nextTrade = futureDates[0];
      if (nextTrade.date > endDate) {
        currentSellDate = expiryTrade.date;
        break;
      }
      events.push(
        buildEvent({
          date: nextTrade.date,
          cash: -nextTrade.close * STOCK_SHARES,
          shares: STOCK_SHARES,
          description: `以 ${nextTrade.close.toFixed(2)} 美元買回股票 ${STOCK_SHARES} 股`,
        })
      );
      currentSellDate = nextTrade.date;
    } else {
      currentSellDate = expiryTrade.date;
    }
  }

  events.sort((a, b) => a.date - b.date);

  const coveredCurve = computeEquityCurves({ tradingDays, events });
  const holdCurve = computeHoldCurve({ tradingDays, firstPrice: firstTrade.close });
  const summary = [
    { name: "Covered Call", value: coveredCurve[coveredCurve.length - 1].value },
    { name: "Buy & Hold", value: holdCurve[holdCurve.length - 1].value },
  ];

  return { coveredCurve, holdCurve, events, summary };
}

async function handleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(form);
  const symbol = formData.get("ticker").trim().toUpperCase();
  const startInput = formData.get("start");
  const endInput = formData.get("end");
  const startDate = new Date(`${startInput}T00:00:00`);
  const endDate = new Date(`${endInput}T00:00:00`);
  const deltaTarget = Number.parseFloat(formData.get("delta"));
  const frequency = formData.get("frequency");
  let riskFreeRate = Number.parseFloat(formData.get("riskFree"));

  if (Number.isNaN(deltaTarget)) {
    throw new Error("請輸入有效的 Delta 值");
  }
  if (!frequency) {
    throw new Error("請選擇期權週期");
  }
  if (Number.isNaN(riskFreeRate)) {
    riskFreeRate = 0;
  }

  try {
    validateDates(startDate, endDate);
    if (!symbol) {
      throw new Error("請輸入股票代碼");
    }
    statusEl.textContent = "下載資料並執行策略模擬中…";
    runButton.disabled = true;
    const result = await runSimulation({
      symbol,
      startDate,
      endDate,
      deltaTarget,
      frequency,
      riskFreeRate,
    });
    renderChart({ covered: result.coveredCurve, hold: result.holdCurve });
    renderSummary(result.summary);
    renderEvents(result.events);
    statusEl.textContent = "模擬完成";
  } catch (error) {
    console.error(error);
    statusEl.textContent = error.message ?? "模擬過程發生未知錯誤";
    renderSummary([]);
    renderEvents([]);
    if (equityChart) {
      equityChart.destroy();
      equityChart = null;
    }
  } finally {
    runButton.disabled = false;
  }
}

deltaRange.addEventListener("input", () => {
  deltaValue.textContent = Number.parseFloat(deltaRange.value).toFixed(2);
});

form.addEventListener("submit", handleSubmit);

initDateInputs();
renderSummary([]);
renderEvents([]);
statusEl.textContent = "請輸入參數並開始模擬。";
