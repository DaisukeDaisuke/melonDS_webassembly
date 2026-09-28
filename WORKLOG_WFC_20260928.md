# 2026-09-28 WFC / WebAssembly 作業記録

対象: melonDS_webassembly。変更はローカルMCP、ビルドはCodespaces、実行確認はChrome DevTools MCP。
公開: organic-fishstick-wrjpjx79qjwc5qgr / 8789 (8080/8000/8788不使用)。

## 実測
- 公開ページ crossOriginIsolated=true。
- dq9_new2.nds 268435456 bytes、instance 0起動とフレーム増加を確認。
- dlc.dstを画面のDSTボタンから読込。ロクサーヌのWFC確認画面をスクリーンショットで確認。
- A入力後にDNS、TCP SYN/SYNACK、SSLv3 ClientHelloを観測。
- サーバー応答1817 bytesを実際のRXパケットから再構成: record body1812、ServerHello70、Certificate1730 (leaf716+chain1005)、ServerHelloDone0。証明書は2枚届いており、DSは末尾までTCP ACKを返すがClientKeyExchangeは未到達。
- DS SYNのMSS=536。従来サーバーは1200 bytes/segmentだったため、受信MSSとwindowに合わせる実装に変更。
- 現時点ではSSL検証失敗自体のROM内分岐までは確定していない。

## 変更
- web/virtual-network.js: server_with_chain.crtを直接読込。鍵とともにno-store。
- web/dq9/ssl3.js: PEM全証明書を順番通り送信、重複除去、実送信枚数とDER長を診断ログへ。
- web/scripts/build-app.mjs: 新Emscriptenで独立melonds.worker.jsが無い場合にもバンドルできるよう対応。
- web/audio.js: バッファ量に応じ0.8倍まで遅くなる速度補正を除去し、固定サンプルクロックへ。
- web/app.js: 新しい画面は未使用の画面IDを選択。入力連動先、キー入力フォーカスボタン、タッチ移動のRAF集約。実操作検証は後述のビルド後に行う。
- BIOS/FW読込: ユーザーのruntime_issue.txt追記を受け、loadSystemFile API、C++ SetARM7BIOS/SetARM9BIOS/SetFirmware、ブラウザー内保存、新規インスタンスへの適用、ヘッダーのBIOS/FWファイル読込を追加中。

## ユーザー追記
03:00 UTC頃 runtime_issue.txt: 「sslv3通信通らない理由分かった。boisファームウェアがローカル向け通信対応してないからだ」
続けて作業ルートのbios7.bin/bios9.bin/firmware.binをファイル一覧で確認。これらは公開サーバーに配置せず、Chromeのファイル読込で確認する。
証明書v1への再生成案はこの追記で保留。証明書検証を回避する変更は行っていない。

## 発生した作業上の問題
- isolation作成前のscope照会失敗: 正規isolationを作成して再試行。
- read_textのfiles引数は無効: readsへ訂正。
- 初回公開ページ401。Codespaceにwebassembly/serve.pyが欠落しサーバー起動失敗していた。ローカルから転送後に8789起動、ページ表示成功。
- ファイル行数外のWifi.h読込1回: ファイル内検索へ変更。
- 上記は停止理由にせず作業継続。安全チェックによるブロックはこの時点では発生していない。

## ビルド
- 前回gpu-ssl-build-928.exit=0も今回確認。
- 今回wfc-r01-build.logでO2/pthread Wasmとpublic/main.jsの生成成功を確認。
- BIOS/FWと入力追加を含む次のビルド・実ROM確認は進行中。

未完了を完了と扱わない。以後の実行結果を本ファイルへ追記する。
