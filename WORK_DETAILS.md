# 調査結果と作業詳細

## ソース確認（指示書以外で裏取りした事実）

- `melonDS_w/src/NDS.h`: `NDS` はCPU、GPU、SPU、Wi-Fi、カートリッジ、RAMをメンバーとして持つ。`RunFrame`, `Reset`, `Start`, `Stop`, `GetPC`, `SetKeyMask`, ARM9/ARM7 Read/Write APIが存在。`UserData` を通したフロントエンドcallbackが必要。16台を表面上の画面だけで偽装せず、16個のコア実体が必要。
- `melonDS_w/src/net/LocalMP.h/.cpp`: 16本の読み取りオフセット、32 semaphore、共有FIFOを持ち、`SendPacketGeneric` がパケットヘッダ(SenderID, Type, Length, Timestamp)を付け、`RecvPacketGeneric` が自分自身の送信をスキップする。返信は別FIFO。送信境界だけでなく受信境界でも観測する必要がある。ヘッダのtimestampはホストの壁時計とは別のDS時間。
- `melonDS_w/src/Platform.h`: MP_Send*/Recv* と Net_SendPacket/Net_RecvPacket は `userdata` を受け取る。Web用Platformを実装することでinstanceの混線を避けられる。通常Wi-FiのデータはEthernetフレーム。Wi-Fi通信の結果をJSからゲームへ直接渡すのは要件に合わない。
- `melonDS_w/CMakeLists.txt`/`src/CMakeLists.txt`: 既存CMakeはネイティブcoreとQt/SDLを対象とし、Web専用targetはない。Qtを無効にしてもPlatformの実装とEmscriptenリンクが別途必要。Teakraもリンクされる。
- `desmume_webassembly-main/src/webmcp.js`: 実装はコマンド一覧/共通call/eval/runScriptをネイティブWebMCPへ登録する設計。そのままコピーするだけでは指示書の「第一級tool」の条件を満たさない。
- `desmume_webassembly-main/src/workers/` と `src/script-*.js`: eval/persistent用supervisorとWorker、RPC・ポリシーが分割されている。単一の `eval` 呼び出しに置き換えず、移植時はセキュリティ境界とcallbackの意味を維持する。
- `dq9_micro_dwc_server_emulator.cpp-main/src/`: DNS、RequestHandler、HTTP/SSL周辺が別サービスとして分割。Wi-Fi→NetDriverをブラウザ仮想ネットワークへ接続した後で参照する。
- Codespace `organic-fishstick-wrjpjx79qjwc5qgr`: 初期状態では `emcc`/`emcmake` 不在。ユーザー指示を受けCodespace内へ apt-get -y で Emscripten 3.1.6 を導入。melonDS_w submoduleはSSH host key未登録のため、一回限りの `git -c url.https://github.com/.insteadOf=git@github.com:` によるHTTPS URL変換で初期化（Git設定は変更していない）。

## 現段階の実装と検証方針

- `webassembly/build.sh` を唯一のWasmビルド入口にし、GitHub Actions (`ubuntu-26.04`) も同じshを使用する。同期SSHで長いビルドを待たないためCodespace用に `build-async.sh` が `.log` と `.exit` を残す。
- 最初に `ENABLE_GDBSTUB=OFF` にするとこのforkの `ARM.cpp` が `Gdb::WatchptKind` を未定義のまま使いコンパイル失敗。ONでcoreをコンパイル。続いてリンク時、coreが`-pthread`未指定で作られ shared-memory が拒否されたので core/teakra をともに `-pthread` コンパイルへ修正。その後のWasmリンクは終了コード0。プラットフォーム動作の確認とは区別する。
- 原本の隔離Worker群と依存ソース一式を `web/sandbox/upstream/` に**フォルダ単位**でコピーした。Actionsは外部アプリのcheckoutを必要としない。Acornハッシュ確認とWorkerのバンドルは同ディレクトリにある参照元のbuild policyを使用。melonDS固有の `web/script-service.js` でRPCとinstanceを接続する。
- `webassembly/port.cpp` が16個の `NDS` と同一 `LocalMP` を保持し、Platformコールバックのuserdataで混線を防止。Wasm Workerは実処理完了を受けてPromiseを解決する。リセット/ROM/Save/State/レジスタ/メモリはコア経路へ。ステップ、breakpoint等は未対応なら明示エラー。
- LocalMPは固定長ringへ実際の送受信raw bytesをコピーし取りこぼしを記録。Wi-Fiは `Platform::Net_SendPacket` と `Net_RecvPacket` 境界でraw Ethernetを観測し、ブラウザの仮想サーバーが返すraw frameを受信queueへ注入する。DNS/DWC等のプロトコルサービスはまだない。
- WebMCPは主要名前ごとのtoolを登録し、AIへの結果はこのリポジトリへ取り込んだ元の `compact-output.js` の境界付きフラットテキストを利用。JSON本文の返却はしない。
- バッチは同一instanceの明示ID付きコマンドを同期順序で実行する。操作IDを付けたAPIはqueue中/実行中/完了/失敗の状態を問い合わせられ、queue中だけキャンセル可能。実行中ネイティブ命令のキャンセルは未接続。メモリ検索はDSメインRAM上のbytesパターンに限定し、フリーズは各frame後に書き戻す方式。
- JS単体チェックはユーザーが「テストするな」と指示する前に4件成功済み。以降のテストは行っていない。Wasm実機起動・ROM/通信・sandboxブラウザ動作は未検証。

## 停止時点の重要な不整合（次チャット最優先）

ユーザーの指示で並列化変更の途中で停止。`port.cpp` の `Instance` にstd::thread/coreMutex/atomic状態を入れ、共有Wasm上の各インスタンス用pthreadで `RunFrame` する方向へ変更したが、`engine.worker.js` のtimerとCMake export/pool設定は旧版。**最新ソースは未ビルドで現状のまま実行すると画面APIが一致せず動作しない**。`HANDOFF.md` 冒頭の具体的修正順序を参照。前回exit 0はこの変更以前の成果物である。
