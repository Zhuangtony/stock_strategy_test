# stock_strategy_test

這個專案提供一個以 Streamlit 建置的互動式網站，模擬 covered call 與單純持有股票策略的比較。使用者可以輸入美股股票代碼、設定模擬區間、目標 Delta 與期權週期（週選或月選），系統會自動下載 Yahoo Finance 的歷史股價與期權資料，計算並繪製資產價值走勢圖以及最終資產比較表格。

## 安裝與執行

1. 建議使用虛擬環境：
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```
2. 安裝相依套件：
   ```bash
   pip install -r requirements.txt
   ```
3. 啟動 Streamlit 伺服器：
   ```bash
   streamlit run app.py
   ```

啟動後開啟瀏覽器並前往指示的網址即可開始互動，設定參數後點擊「開始模擬」即可查看圖表、交易紀錄與最終資產比較。
