# Agents
這個項目是用electron搭建的，用於多個ai agent cli管理的GUI工具，目前只針對claude code

## 核心功能
claude帳號管理、session管理

## 解決問題
- 多個claude訂閱賬號的limit管理、切換
- session狀態 terminal窗口排列展示 消息通知

## ui
shadcn/ui
Tailwind CSS
多語言 暫做簡/繁中和英文
dark/light

## 功能設想
- claude訂閱賬號添加，指定本地的配置路徑，然後給到登錄鏈接，不要直接喚起瀏覽器，連接要可以打開也可以複製
- session創建必須要選擇工作目錄，賬號、達上限規則(自動切帳號、不動作，手動切換、等用量刷新自動發continue)、啟動參數等可以選擇也可以默認自動，後期隨時可以改
- session必須在claude非工作時才能改帳號，改帳號要移動claude的session文件到目標帳號的目錄並resume
- 後端負責監控帳號的用量，觸發方式可以前端手動觸發reload，對活躍session的帳號定時reload，session每次執行完一個任務也要reload
- app啟動時要恢復狀態
- 主界面是櫥窗排列所有session小窗口，上面包括session的狀態(閒置、running、有問題要我處理、任務完成、到限額卡住等)，和用的哪個帳號。光標經過顯示更多訊息和操作，例如顯示帳號用量、用獨立窗口打開、刪除、排序等，點擊小窗口內active terminal，並且出現chat input，鍵盤快捷鍵等可以作用於terminal
- 櫥窗可以自適應、可以拖拽排序，可以用用獨立窗口打開，用了獨立窗口後櫥窗佔位還在，點擊激活窗口
- terminal外掛的input是為了更方便輸入，例如還行、黏貼圖片、文件路徑等更方便，如果點擊terminal區域鍵盤還是直接和terminal交互

另外有個疑問： 切換帳號的時機你看下怎樣比較好，是發送promt時判斷是否要切還是遇到限額提示才決定要不要切，如果要切就切好之後發continue?

## 交付
主要在mac電腦上用，需整理好打包腳本