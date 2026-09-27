# 調査結果と作業詳細

## ソース確認（指示書以外で裏取りした事実）

- `melonDS_w/src/NDS.h`: `NDS` はCPU、GPU、SPU、Wi-Fi、カートリッジ、RAMをメンバーとして持つ。`RunFrame`, `Reset`, `Start`, `Stop`, `GetPC`, `SetKeyMask`, ARM9/ARM7 Read/Write APIが存在。`UserData` を通したフロントエンドcallbackが必要。16台を表面上の画面だけで偽装せず、16個のコア実体が必要。
- `melonDS_w/src/net/LocalMP.h/.cpp`: 16本の読み取りオフセット、32 semaphore、共有FIFOを持ち、`SendPacketGeneric` がパケットヘッダ(SenderID, Type, Length, Timestamp)を付け、`RecvPacketGeneric` が自分自身の送信をスキップする。返信は別FIFO。送信境界だけでなく受信境界でも観測する必要がある。ヘッダのtimestampはホストの壁時計とは別のDS時間。
- `melonDS_w/src/Platform.h`: MP_Send*/Recv* と Net_SendPacket/Net_RecvPacket は `userdata` を受け取る。Web用Platformを実装することでinstanceの混線を避けられる。通常Wi-FiのデータはEthernetフレーム。Wi-Fi通信の結果をJSからゲームへ直接渡すのは要件に合わない。
- `melonDS_w/CMakeLists.txt`/`src/CMakeLists.txt`: 既存CMakeはネイティブcoreとQt/SDLを対象とし、Web専用targetはない。Qtを無効にしてもPlatformの実装とEmscriptenリンクが別途必要。Teakraもリンクされる。
- `desmume_webassembly-main/src/webmcp.js`: 実装はコマンド一覧/共通call/eval/runScriptをネイティブWebMCPへ登録する設計。そのままコピーするだけでは指示書の「第一級tool」の条件を満たさない。
- `desmume_webassembly-main/src/workers/` と `src/script-*.js`: eval/persistent用supervisorとWorker、RPC・ポリシーが分割されている。単一の `eval` 呼び出しに置き換えず、移植時はセキュリティ境界とcallbackの意味を維持する。
- `dq9_micro_dwc_server_emulator.cpp-main/src/`: DNS、RequestHandler、HTTP/SSL周辺が別サービスとして分割。Wi-Fi→NetDriverをブラウザ仮想ネットワークへ接続した後で参照する。
- Codespace `organic-fishstick-wrjpjx79qjwc5qgr`: `/workspaces/melonDS_webassembly` が存在し、nodeとcmakeは見つかったが`emcc`/`emcmake`はPATHに存在しなかった（2026-09-27）。実ビルドはまだ確認できない。

## 現段階の実装と検証方針

- Web側にタイル配置・対象instance・操作を管理する基盤を作り、実コアの代わりとなる疑似実装は置かない。バックエンド未接続は明示的なエラー。APIのPromiseはバックエンドが操作完了を返した後で解決し、インスタンスごとに順序付ける。
- ロガーは実バックエンドが送信するパケットイベントだけを表示し、テスト用サンプルを実通信として表示しない。
- ここでのJS単体テストはAPI入力検証・操作直列化・レイアウト復元に限る。エミュレータ、LocalMP、Wi-Fi、DWCを動作確認したことにはならない。
