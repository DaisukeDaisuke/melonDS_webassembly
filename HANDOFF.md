# 次チャットへの引き継ぎ（melonDS WebAssembly Web Debugger）

## 2026-09-27 最終引き継ぎ（この節と `PLAN.md` 最終節を最優先）

本日ユーザー指示で作業終了。**今はビルドしない。Web上のデバッグも試みない。** `sizisilyo.txt` の19完成条件と `PLAN.md`/`WORK_DETAILS.md` にある全計画の実装を終える前にビルドへ進まない。gitコマンドは使用しない。外部の `desmume_webassembly-main` ディレクトリには依存させない。Codespaceへの転送が必要になった場合は `gh codespace cp -e` を必ず付け、ビルドは後日 `build-async.sh` で非同期実施する。

今回ソースは大きく変わったが、pthread化以降の **C++/Wasmは未ビルド・未リンク・ROM未起動・ブラウザ未検証**。`web/dist/melonds.*` は古い逐次版なので新Workerとの動作根拠にならない。最後に実行したNode単体テストは10件成功（`web/tests/api.test.js` に最後に加えたテストは未実行）。Codespace `organic-fishstick-wrjpjx79qjwc5qgr` の `web/`/`webassembly/` は途中段階のコピーで、最後の編集と `melonDS_w/src` のARM/CP15変更はまだ反映されていない。

**次回の最初の行動:** `PLAN.md` の「2026-09-27 作業終了時点」および「ビルド着手条件」を読む。`webassembly/port.cpp` のデバッガcoreMutex解放・条件変数・abort/Stateフレーム境界、`melonDS_w/src/{ARM.cpp,CP15.cpp}` のinterpreter hook、`web/engine.worker.js`・`script-service.js` の非同期応答/ブレークポイントcallback、CMake exports整合を静的に点検して残りの仕様を実装する。ブラウザ動作や16台通信の成功を推測で記入しない。チェックアウト済みサブモジュールを直接編集している。不要なPythonパッチスクリプトはユーザーの指摘に従い撤去済み。

DQ9側は `web/dq9/generate-certs.sh` に原本 `dummy-certs-linux` 相当の生成を実装し、同一オリジンの `web/dq9/certs/` をJSで読む設計。`server.crt` だけでなく元の `nwc.crt` も同じSSLv3 Certificateメッセージに含める。証明書はまだ実生成していない。DLCは独立File ExplorerタイルからIndexedDBの `/YDQJ/_list.txt` 等へUTF-8/バイナリをアップロードし、WFCハンドラがリクエスト時に参照する。こちらもブラウザ動作は未確認。

以下にある前回・途中時点の記録は履歴であり、記述の「未整合」等を最新ソースの状態として扱わないこと。

## 2026-09-27 状態更新（以下の旧「最優先」欄よりこちらが新しい）

前回のpthread化とWorker/CMakeの画面API不整合はソース上修正済み。`_web_copy_frame`/`_web_peek_frame_number` の使用、表示中画面だけの画像送信、画面なしinstanceへの軽量tick、pthread上のfreeze処理を揃えた。デバッガ命令hook/step/breakpoint/Call Stack、音声、入力記録/再生、ブラウザ内Save/State保存、DQ9仮想LAN/SSLv3/ファイルタイルなどを追加実装中。**これらの新しいC++変更は一度もビルドされておらず、ブラウザ・ROM・LocalMP/DQ9通信でも未検証**。`PLAN.md` の最新状況/ビルド着手条件を優先する。

ユーザーの最新指示: 全計画の実装を終える前にビルドへ進まない。実施する場合は非同期、Codespace転送は `gh codespace cp -e` 必須。Web上でのデバッグは禁止中。git操作は行わない。チェックアウト済み `melonDS_w` を直接編集しており、余分なPython差分適用スクリプトは撤去した。外部の `desmume_webassembly-main` ディレクトリに依存させない。DQ9証明書は元のdummy-certs-linux手順を `web/dq9/generate-certs.sh` とCIに取り込み、同一オリジンの `web/dq9/certs/` からleaf+元のnwc.crtチェーンをロードする実装。証明書の実生成と画面動作はまだ確認していない。

以下は以前の引継ぎ記録で、旧「未整合」「未実装」の記述が現ソースと食い違う箇所がある。最新の実施状況は必ず `PLAN.md` と現ソースを参照すること。

## 最優先: 直近の未完了変更を先に整合させる

ユーザーの指示により、**並列化の途中で作業を停止した**。直近の `webassembly/port.cpp` は `NDS` ごとにpthreadを起こし、共有Wasmメモリ内のLocalMPを実際に共有する方向へ変更したが、**この変更後のビルドは実行していない**。ROM動作も検証していない。現状を完成版として使わないこと。

とくに以下は現在**不整合**で、次の担当者はまずここから修正すること:

1. `webassembly/port.cpp` で `web_framebuffers` を削除し `web_copy_frame(instanceId, destination, capacity)` にしたが、`webassembly/CMakeLists.txt` はまだ `_web_framebuffers` をexportし、`web/engine.worker.js` の `frame()` と `screenshot` も古い `_web_framebuffers` を呼ぶ。これを `_web_copy_frame` で安全に2画面をコピーする方式へ統一する。pthreadがGPUを更新中に生ポインタを読む設計へ戻してはいけない。
2. `web/engine.worker.js` の60fps timerはまだ `_web_frame` を順次呼ぶ。pthreadを起こした後はtimerが各機を進めてはいけない。`port.cpp` に追加した `_web_peek_frame_number` をポーリングし、更新時だけフレーム/イベントを発行する方式へ変更する。画面タイルが不要なinstanceまで毎回400KB転送せず、表示対象を絞る。一方、画面タイルがなくてもpersistent scriptのtickイベントは必要。
3. CMakeの `PTHREAD_POOL_SIZE` は現状 `0`。インスタンスごとのpthreadとGPU側のthreadが使用可能な数へ調整し、Emscriptenで **ビルドのみ**行う（現在ユーザーがテスト・ROM確認を禁止している）。`port.cpp` の `std::thread` 作成・終了、`mutex`、pauseの完了保証、16インスタンスのリソースに注意する。
4. `webassembly/port.cpp` のrunner変更を見直すこと。既存コアの `NDS::RunFrame` が参照するGPU/SPU/LocalMPは別threadから呼ばれる。セーブコールバック、Stateの復元・frame番号更新、Stop/Resetの境界、Workerからのメモリ読書きに同じinstanceのlockが適用されるようにする。

この状態で古いビルド済み `web/dist/melonds.*` は**直近のpthread化を含まない**。先のビルド成功（exit 0）は単一Workerで逐次フレームを回す版についてのみ。ユーザーがROM検証を次チャットに任せるまで、このチャットでは行っていない。

## 今回の作業と条件

- 原本仕様 `sizisilyo.txt` を最優先し、UIは `interface-design/.claude/skills/interface-design/SKILL.md` を参照する。見た目のタイルだけで19完成条件を達成したと判断しない。
- ユーザー指定: **このチャットでROM動作確認やテストをしない**。ROM実動確認は次の新規チャットの担当者へ引き継ぐ。ビルドは `webassembly/build.sh` を GitHub Actions (`ubuntu-26.04`) から実行する。Codespaceの `gh codespace cp` には必ず `-e` を付ける。データ転送はフォルダ単位。
- DeSmuME原本を別checkoutするActions依存は削除。隔離Worker原本、ハッシュ監査ポリシー、npm lock、LICENSE を `web/sandbox/upstream/` にディレクトリ単位でコピー済み。元の用途と保守方法は `web/sandbox/upstream/PROVENANCE.md`。AIへのWebMCP出力は原本コピーの `compact-output.js` による簡潔なテキスト（JSON本文は送らない）。

## 構成

| 場所 | 内容 |
|---|---|
| `webassembly/build.sh` / `CMakeLists.txt` | Emscripten Wasmビルド。Qt・JIT・OpenGL無効、現forkのコンパイル制約でGDB stub有効、core/teakraとも `-pthread`。成果物は `web/dist/melonds.js`, `.wasm`, `.worker.js`。 |
| `webassembly/port.cpp` / `platform.cpp` / `virtual-net.h` | 16個のNDS、共有LocalMP、エミュレーション呼び出し、画面、ROM/Save/State/メモリ/CPU、Platform userdata、NetDriver raw Ethernetキュー。**直近のpthread変更とJS側は未整合（上記参照）**。 |
| `melonDS_w/src/net/LocalMP.{h,cpp}` | LocalMPの送受信を固定長ringへコピー。通信FIFOは変更せず、ログ超過は観測記録だけ破棄する。 |
| `web/engine.worker.js` / `backend.js` / `api.js` | Wasm Worker分離、完了返信付きRPC、明示的instanceId、同一instance操作の順序保証、主RAM限定の検索とフレーム境界でのフリーズ、キュー中操作の取消・状態取得。未実装の命令step・breakpoint等はエラーで返す。 |
| `web/index.html` / `app.js` / `style.css` / `layout.js` | 画面とデバッグ系の独立タイル、Gridと自由配置、リサイズ・Drag & Drop・localStorage復元。 |
| `web/sandbox/upstream/` / `web/scripts/build-workers.mjs` / `web/script-service.js` | コピーした原本のparser/isolated eval/persistent supervisorとsandboxをハッシュ検証付きでバンドル。melonDS instanceへのRPCをアダプト。現時点でnativeブレークポイントcallbackは未接続。 |
| `web/virtual-network.js` | JSサービスがraw Ethernetを処理し、応答を`Platform::Net_RecvPacket`へ注入する基礎。DNS/TCP/DWCの実サービスはまだ未実装。 |
| `web/webmcp.js` | 個別tool登録。Fileはbase64をBlob化。原本コンパクトテキストで返す。 |

## ビルドと成果物

Codespace `organic-fishstick-wrjpjx79qjwc5qgr` にapt版 Emscripten 3.1.6 が導入済み。ユーザー指示のためSSH内で同期ビルドしない。編集済みディレクトリを転送して `gh codespace ssh -c organic-fishstick-wrjpjx79qjwc5qgr "nohup bash /workspaces/melonDS_webassembly/webassembly/build-async.sh > /dev/null 2>&1 < /dev/null &"`。`webassembly/build.exit` の内容を確認し、失敗した場合だけ `build.log` の末尾を読む。転送例: `gh codespace cp -r webassembly remote:/workspaces/melonDS_webassembly/ -c organic-fishstick-wrjpjx79qjwc5qgr -e`。ビルド結果は `gh codespace cp -r remote:/workspaces/melonDS_webassembly/web/dist web/ -c organic-fishstick-wrjpjx79qjwc5qgr -e`。配布Actionsは `web/sandbox/upstream` の `npm ci --ignore-scripts` 後、同梱の `build-workers.mjs` で原本Workerを生成し、外部DeSmuMEレポジトリをcheckoutしない。

初回構成で `ENABLE_GDBSTUB=OFF` にするとforkの`ARM.cpp`がコンパイルエラー。ONで解消。coreライブラリに`-pthread`がないとWasm共有メモリlinkエラー。CMakeで解消し、**並列化以前の版**のWasmリンクは正常終了。最新の並列化編集は未ビルド。

## 次の担当者が確認すべきこと（ユーザー指示のROM検証）

1. `PLAN.md`/`WORK_DETAILS.md` と `sizisilyo.txt` を読む。今チャットの未実装項目を完成済みと誤認しない。
2. Wasm/workerのロードにはCOOP/COEPによる`crossOriginIsolated`が必要。`web/coi-serviceworker.js` は静的ホスト向けに設けた。localhost/HTTPSで配信し、初回service worker install時は再読込される。
3. 再配布可能なホームブリューROMでインスタンス0の画面とROMロードを確認。Save/Stateと画面表示を検証。ROMや個人データの本文をチャット／リポジトリへ出さない。
4. 2台LocalMPの実ゲーム通信を検証し、`Local Communication Logger` の実packet TX/RX、SenderID、受信先、raw bytesを照合。最大16台で同時運転、状態・入力の分離とFPSを確認。現行成果物は単一Wasm Workerの逐次版。ソースではpthread並列化の途中で止まっている（最優先欄）。
5. Wi-Fiが `Net_SendPacket` / `Net_RecvPacket` を通り、raw loggerに記録されることを確認。`dq9_micro_dwc_server_emulator.cpp-main` は参照であり、DNS/TCP/HTTP/DWC互換サービスは追加実装が必要。
6. 元のscript supervisor/isolated Workerについて起動・登録・停止・MCP・callbackをブラウザで検証し、失敗時のqueue/timeout/cleanupを整合させる。native exec/read/write breakpoint hookがないため現在のbreakpoint callbackは拒否する。

## 残作業の優先順

1. ARM9/ARM7の真のinstruction step / step over / run until / exec-read-write breakpointを、melonDSインタプリタとNDS schedulerの停止・再開契約を壊さず接続。中途半端なフレームstepをinstruction stepと呼ばない。persistent Workerのbreakpoint callbackへ繋ぐ。
2. `web/engine.worker.js` のframe駆動とLocalMPの待ち合わせタイミングを実機で検証し修正。16台でも処理・表示の混線を起こさない。
3. 実際のEthernet経路上でDNS/ARP/UDP/TCP/HTTPとDWC認証・ダウンロードを行うブラウザ内サービスを実装。JSが直接ゲーム結果を捏造しない。
4. メモリ検索・凍結を拡充、Save/State browser永続化、入力記録・再生、wait/batch/キャンセル、音声、scriptイベント契約とWebMCP各toolの結果詳細を整える。

テスト結果を推測で記入しない。今回のチャットではユーザーの後続指示に従いROM確認もテストも実施していない。
