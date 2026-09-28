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

## 03:38 UTCまでの継続結果

### WFCの実通信成立
- ユーザーがruntime_issue.txtで手動操作による接続成功を報告。nas.testへ向く条件と、conntestのHTTP応答を一字も変更しない必要性を指摘。
- こちらも公開ページの実ログで12:35:26/12:35:28 JSTのClientKeyExchange/RSA復号、Finished検証成功、SSLv3接続確立、POST dls1.nintendowifi.net/download → HTTP/1.1 200 OK、および応答のACK/FIN完了を確認した。
- conntestの生応答はユーザーが追記した文字列と現在のweb/dq9-wfc.jsで一致。Content-Length等を追加する再構築は通さずraw応答のまま返す。DNSを変える追加修正はしていない。
- 接続成功したタブpage10は維持。残りは別ブラウザーコンテキストpage13で確認する。
- BIOS7/BIOS9/Firmwareを実機ファイルから読込、nativeBios7/nativeBios9=trueを確認。BIOS/FW UIはヘッダーから独立したツールタイルへ移動。
- 元workflowのOpenSSL 1.1.1w手順を再現。leafはX.509 v1/711 bytes、chain1005 bytes。生成物4点をローカルweb/dq9/certsにも反映済み。前の生成物はcerts-reference/previous-v3-*へ退避。
- 観測済みClientHelloをOpenSSL1.1.1w本体へ渡して得た実応答は1822 bytes、レコード長74/1729/4で、JS実装と構成一致。証明書形式だけを変えたdlc.dstの再試行では未接続だったため、証明書のみが根本原因だったとは断定しない。

### 保存/UI/配信
- .mel可変長バイナリの全体保存/読込、ROMハッシュ単位の同梱重複除去、全instance状態/停止状況/10slot/BIOS/FW/入力/デバッガ設定/LocalMPキュー/仮想AP/NetDriver/TCP/SSL暗号状態/配置/ログ/DLCを実装。
- 29_dlcs.savを読込してリセット後に実ゲームを起動。64 KiBのSave出力を確認。
- .mel初回実測: 288405350 bytesを書き出し、破棄・再生成・読込でpaused=true/frame4484へ復帰。従来State仕様により、命令停止中の保存は実行中フレームを完走してcheckpointを作るため、保存前4483から4484になった。保存後の実frameをメタデータへ記録するよう修正。
- 初回復元直後は停止画面が白くなったため、公開用の最終フレームバッファとセーブのshadowをtransportへ追加。新transport版は2として旧作業中版を誤読しない。実動再確認中。
- 常駐スクリプトはソース/対象/nameを同梱し、復元時は停止状態。任意JS Workerの実行中スタックの復元は行わない。任意のカスタム通信closureは保存非対応を明示し、黙って捨てない。
- SWはmain.js/wasmの取得をメモリー内で共有。CacheStorage不使用。新ビルドIDでSW更新。独立ブラウザーコンテキストでSW制御とcrossOriginIsolated=trueを確認。
- Wi-Fiログで復号したRequest/Responseを一つの詳細表示に統合、再構成済み表示フィルター追加。
- タッチはRAF集約に加え、処理待ちの移動だけを最新座標へ置換するbackpressureを追加。押下/解放は省略せず順序を維持。.mel読込前に旧画面の押下を解放して完了を待つ。

### 継続中に発生した問題と対応
- 2回の安全チェック拒否: 複合ビルドコマンドと複数ファイルUIパッチ。通常の小さい操作へ分割して実行できた。停止理由にはしていない。
- NativeビルドでARM7BIOS/ARM9BIOSがprotectedだった: public GetARM7BIOS/GetARM9BIOSへ修正してビルド成功。
- OpenSSL1.1.1wにはmake build_swターゲットがなかった: 元手順と同じmakeへ変更し生成成功。
- 何度かapply_patchの文脈不一致: 変更未適用を確認し現物の該当行を読み直して小さく再実行。
- SSL末尾のreplace_textで改行差異により不一致: apply_patchに切替。最終JSバンドル成功。
- copy_from_codespace初回の引数名が不正: 正式schema(remoteSource/localDestinationDirectory)で再実行して証明書コピー成功。
- .mel復元後の古いChrome要素IDでスクリーンショット失敗: 現DOM/viewportで撮影し直した。
- ファイルの行範囲超過(Wifi.h/ssl3.js/style.css)は現在の行数・検索結果で読み直した。
- Ghidraの稼働インスタンスなし。利用可能な実Wasm通信ログとChrome/Codespacesで調査を継続。

新規テスト基盤・テストファイル・sanitizerは作成/実行していない。以後の実測結果を追記する。
