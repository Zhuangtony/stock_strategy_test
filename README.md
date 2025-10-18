# stock_strategy_test

這個專案提供一個純前端（HTML/CSS/JavaScript）實作的 Covered Call 模擬器，直接在瀏覽器端向 Yahoo Finance 下載歷史股價與期權資料，並比較 sell covered call 與單純持股的資產變化。應用程式設計為可部署於 GitHub Pages，不需要額外的後端或伺服器。使用者可以：

- 輸入美股股票代碼、模擬起迄日期
- 設定目標 Delta 與選擇週選／月選
- 調整年化無風險利率
- 檢視資產走勢、最終資產比較與交易事件紀錄

## 將檔案上傳至 GitHub 儲存庫

無論是要建立 Pull Request，或只是想把檔案同步到 GitHub，都必須先把目前的檔案推送(push)到一個遠端儲存庫。以下提供兩種常見方式：

### 方式 A：使用 Git 指令推送到 GitHub

1. 在 GitHub 網站上建立一個新的空儲存庫（假設名稱為 `covered-call-simulator`）。
2. 回到本機專案根目錄，初始化 Git 並提交目前的檔案：
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
3. 將遠端儲存庫加到本機，並推送到 `main` 分支：
   ```bash
   git branch -M main
   git remote add origin git@github.com:<你的帳號>/covered-call-simulator.git
   git push -u origin main
   ```
   > 若尚未設定 SSH 金鑰，可改用 HTTPS：`https://github.com/<你的帳號>/covered-call-simulator.git`
4. 之後若要建立 Pull Request，只要在新的功能分支上修改並推送即可。

### 方式 B：直接在 GitHub 介面上傳檔案

1. 在 GitHub 建立一個新的儲存庫。
2. 點選 **Add file → Upload files**，將 `index.html`、`styles.css`、`main.js` 和 `README.md` 直接拖曳上傳。
3. 填寫提交訊息後按下 **Commit changes**。GitHub 會自動幫你建立第一次提交。
4. 之後如需更新檔案，可重複上傳或改用 Git 指令流程。

## 部署到 GitHub Pages

當檔案已經推送到 GitHub 後，可以按照以下步驟啟用 GitHub Pages：

1. 在 GitHub 介面中開啟儲存庫的 **Settings → Pages**。
2. 在 **Build and deployment** 區塊選擇：
   - **Source**：Deploy from a branch
   - **Branch**：選擇 `main`（或你的預設分支）並設定資料夾為 `/root`（或 `/(root)`）
3. 儲存設定後等待 GitHub Pages 建置完成，即可透過提供的 URL 存取網站。

若想維持原始 Streamlit 版本，可查看舊的 Git 提交記錄；目前的主分支已改為適合 GitHub Pages 的純前端版本。

## 本地預覽

因為應用程式是靜態網頁，可以直接以瀏覽器開啟 `index.html` 測試。不過若需模擬與 GitHub Pages 相同的情境，建議啟動簡單的靜態伺服器，例如：

```bash
python -m http.server 8000
```

接著在瀏覽器造訪 <http://localhost:8000> 即可。

## 注意事項

- Yahoo Finance 介面偶爾會限制請求頻率，若短時間內多次重新模擬可能導致載入失敗，稍後再試即可。
- 期權資料的 Delta 值以 Black-Scholes 模型重新估算，因市場資料品質不同，可能與實際報價略有差異。
- 模擬結果僅供學術與教育用途，實際交易請自行評估風險。
