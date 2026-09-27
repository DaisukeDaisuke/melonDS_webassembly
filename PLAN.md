# melonDS Web Debugger 実装計画

## 目標と判定方法

指示書 `sizisilyo.txt` の19項目を完成条件とする。UIだけが動いてもエミュレーション・通信が成立したとは判定しない。ROMを実機相当のコアで起動し、16台の独立性、実際のLocalMP/Wi-Fiパケット、完了後に解決する非同期操作をそれぞれ検証する。

## 調査に基づく構成

1. `melonDS_w/src` をWasm向けにビルドする。Qt/SDL、OpenGL、JITを除き、`Platform.h` のファイル・同期・ネットワーク・音声等の実装をWeb用に用意する。現forkはGDB stub無効でARM.cppがコンパイルできないためビルド時に有効化する。`NDS` のインスタンスを固定枠0..15で管理し、同一の `LocalMP` を共有する。マルチプレイのタイミングが必要ならpthread、COOP/COEPを検証する。
2. バックエンドの非同期メッセージ境界を設け、インスタンスごとの操作順序を保証する。操作完了・失敗はコアが実行した結果で確定する。ROM/セーブ/ステートはインスタンス単位のデータとして扱う。
3. ブラウザ側は `instanceId` 必須のAPIと個別のツールタイルを用意する。一覧のCSS Gridと自由配置を切り替えられるようにし、タイル配置のみlocalStorageへ保存する。
4. デバッガ（両CPU、read/write/exec breakpoint）、操作と観測を実際のコアへ接続する。LocalMPのsend/receive主要境界とNetDriver境界でraw bytesをコピーしてロガーへ送る。バッファ上限と取りこぼしカウントを設ける。
5. DeSmuME版の永続スクリプトWorker・RPCをポリシーと一緒に移植し、各RPCにinstanceIdを必須化する。WebMCPは個別toolを登録する。DWC参照実装はDNS/認証/サービスの仕様確認に使い、実通信はWifi→NetDriver→仮想ネットワークを通す。
6. CodespaceのEmscriptenでビルドし、ホームブリューROM等の再配布可能なテストデータで画面、2台のローカル通信、16台、save/state、logger、ブラウザ再起動を検証する。

## 実施状況

- [x] ソース構造・参照実装・ビルド環境を調査。詳細は `WORK_DETAILS.md`。
- [x] UI/API基盤、Wasm呼び出しWorker、ブラウザ内の原本Workerソース管理、実データのLocalMP/Wi-Fi記録経路を追加。
- [x] Web用PlatformとWasmエントリーポイントを追加し、**逐次実行版**をCodespaceでリンクまで確認。
- [ ] pthreadでの16台並列化は変更途中。`HANDOFF.md` の最優先項目を整合させ、ビルド確認する。
- [ ] ROM実行をブラウザで確認し、16台の同時動作とLocalMPの実通信を確認。
- [ ] 原本Worker群のブラウザ起動・callback/ブレークポイント連携を検証し機能等価にする。
- [ ] DeSmuME相当のステップ・ブレークポイント・検索・フリーズ・入力記録等をコアに実装。
- [ ] Wi-Fi仮想ネットワークのDNS/TCP/HTTP/DWCサービスを実装。現段階はraw Ethernetフレームの送受信注入とロギングまで。
- [ ] WebMCP第一級toolの未実装操作をすべて接続し、ブラウザ仮想サーバーのDWC互換を検証。

## 2026-09-27 継続作業の現状と方針

- 今回はWeb上のデバッグ・ROM確認を行わない。`desmume_webassembly-main` の実行時・ビルド時依存を作らず、必要な資料・コードは本リポジトリに置く。git操作は行わない。Codespaceとの転送は `gh codespace cp -e`、ビルドは `build-async.sh` により非同期で実施する。
- 文書の引継ぎ時点と現ファイルに差がある: `webassembly/CMakeLists.txt` は既に `_web_copy_frame` のexportと `_web_frame` の手動step用export、pthread pool 32 に更新済み。一方 `web/engine.worker.js` は旧 `_web_framebuffers` を参照し、timerが `_web_frame` を実行しているため現ソースのWasmとは不整合。ビルド済み成果物はpthread化以前のものとして扱う。
- 修正方針: 各NDSの専用pthreadのみが通常フレームを進め、Workerはatomic frame番号を監視する。画面のコピーは `web_copy_frame` でinstanceのmutexを保持した状態で二画面を一括コピー。画面タイルのある対象のみ画像を送信し、画面タイルのない対象にも軽量のframe通知を送ってpersistent scriptのtickを維持する。
- 破壊操作の返答は対象コアのmutexでフレーム実行終了を待ち、Stop/Reset/State復元とframe番号を一体で更新してから返す。pause中の明示フレーム実行とコア読書きも同じmutexで直列化する。フリーズは逐次timerに依存できなくなるのでrunnerのフレーム境界へ移す。ビルド結果は確認後この計画書に追記し、ブラウザ上の実動確認は未検証として残す。
- 実装済み（ビルド前）: Worker timerを `_web_peek_frame_number` の変化監視へ変更し、画面表示対象のみ `_web_copy_frame` でsnapshotを送信。非表示機にも画像なしframe通知を送る。画面タイルの生成・切替・最小化・削除で表示対象を更新する。フリーズはpthread側のフレーム終了直後に適用し、解除・ROM再読込時もcoreと同期させる。`_web_peek_frame_number` とフリーズAPIをexport追加。JSの静的構文確認（4ファイル）は成功。ブラウザ上の実行・ROM・通信は未確認。
- 追加指示（2026-09-27）: 編集のたびのビルド確認を避けて実装を優先する。`webassembly/` はCodespaceへディレクトリ単位で転送済みだが、非同期ビルドはまだ起動していない。**指示書・HANDOFF・PLAN・WORK_DETAILSの残り全項目を実装するまでビルドへ進まない。** Web上のデバッグも行わない。
- 追加実装（未ビルド）: ROM再ロード・reset・destroy時に旧NetDriver受信キューとLocalMP参加状態を掃除し、同じIDを再利用した際の混線を防ぐ。Wasm Workerへの非同期Blob読込を伴う要求も着信順に処理。melonDSソフトウェアGPUのBGRA画素をブラウザのRGBAへ変換。`web/lan-services.js` に実際のEthernet要求に応じるARP/IPv4 UDP DHCP(DISCOVER/OFFER, REQUEST/ACK)/DNS(AとNXDOMAIN)応答を追加し、`melondsVirtualNetwork.registerLan({instanceId,address,clientAddress,domains})` から設定できる。これはDWC完成ではなく、TCP/HTTP/認証・ダウンロードは今後の実装対象。

## 2026-09-27 追加依頼: DQ9 WFCサーバーのブラウザ内JS移植

- 原本 `dq9_micro_dwc_server_emulator.cpp-main/src` を参照した。サービスは `dns.cpp` の `*.nintendowifi.net` A応答、`HTTPHelper.cpp` の80番接続テスト、`SSLHelper.cpp` の443番SSLv3+RC4とHTTPの読み書き、`RequestHandler.cpp` のNAS `/ac` login/svcloc・`/pr` とDLS `/download` count/list/contents。原本 `dlc/` は空で配信データは利用者指定。原本証明書は `dummy-certs` を外部ファイルとして要求し、ここには同梱されていない。
- 方針: 元の別ディレクトリをビルド/実行に参照せず、ブラウザ内の独立したJSサービスとしてHTTPルーティング・ユーザー提供DLCストレージ・DNS・raw Ethernet上のTCPをこのリポジトリに実装する。DS→Wifi→NetDriver→JS TCP→サーバー→NetDriverの往復を維持し、JSから直接ゲームに結果を書かない。原本でSSLv3/RC4を使う443番はブラウザWebCryptoの標準TLSサーバーAPIでは提供されないため別途実装が必要。TLS相当の実装とDS側接続は未検証なら完成扱いしない。
- 新しいユーザー指示に従い、この移植だけでビルドに進まず、全計画を終えてからまとめて非同期ビルドする。Web上のデバッグは行わない。
- 実装途中: 原本RequestHandlerのNAS `/ac` login/svcloc、`/pr`、DLS `/download` count/list/contentsを `web/dq9-wfc.js` に移植。DLCは各gameの `_list.txt` と名前付きbinaryをJSで指定し、外部ディレクトリへ依存しない。原本MIT noticeは `web/dq9/LICENSE` に格納。`web/tcp-service.js` がEthernet内IPv4/TCPをACKでペース制御してHTTP要求を組み立てる。`registerDq9Wfc()` はDNS wildcard・DHCP・ARP・TCPを統合。**443番はSSLv3 record/RC4ハンドシェイク未実装のため、現時点ではDQ9の実WFC接続は成立しない。** SSL層と提供された証明書を接続することが次の実装課題。
- 続いて `web/dq9/ssl3.js` にSSLv3 RSA鍵交換/RC4-SHA・RC4-MD5/record MAC/FinishedをJS実装し、同じTCP経路の443番へ接続した。APIは `melondsVirtualNetwork.registerDq9Wfc({instanceId, certificatePem, privateKeyPem, chainPem, dlc})`。原本の `dummy-certs` は参照ディレクトリにも同梱されていないため、証明書/秘密鍵は利用者から渡す設計。実機WFC通信・TLS互換・TCP再送/切断はまだ**未検証**で、TLS実装があるだけで完成とは判断しない。関連するプロトコル境界の検査後にビルドする。
- ユーザーによる補足: 対象は `dq9_micro_dwc_server_emulator.cpp-main/.github/workflows/windows-msbuild.yml` の `dummy-certs-linux`（NintendoCertsの `WII_NWC_1_CERT.p12` を原本と同じ方法で抽出し、1024bit RSA server.key、CSR、SHA1 server.crtを作る工程）。C++元ディレクトリに証明書がないことと、生成手順がないことは別問題。melonDS側へこの工程をコピーし、成果物 `web/dq9/certs/` を**Web UIと同一オリジン**でホスト、JSから相対URLで読み込む。起動時に原本ディレクトリへ依存しない。通信定数も先述の原本照合に従う。
- 追加の重要条件: SSLv3のCertificateメッセージに **server.crt（生成した証明書）とnwc.crt（元のPKCS#12由来の証明書）をこの順序で含める**。server.crt単独はDS側から拒否される。同一オリジンのローダーは server.crt・server.key・nwc.crt を読み、`ssl3.js` はleaf+chainの2証明書を送る。チェーンを含むハンドシェイクを単体テストで固定する。証明書生成は独自リポジトリの `web/dq9/generate-certs.sh` と配布CIで行う。
- ユーザー指定: DLCのUTF-8テキストとバイナリを独立した **File Explorerツールタイル** からIndexedDBにアップロード・参照・編集できるようにする。ファイル/フォルダのDrag & Dropと同等のJavaScript APIも用意する。キーは `dlc/<gamecd>/<filename>` の原本構造を維持し、WFCサービスはリクエスト時にこのDBを参照するため再登録なしで変更を反映する。画面タイル・デバッガと同様、必要な時だけこのツールタイルを配置可能とする。
- ユーザー訂正: File Explorerの仮想パス/IndexedDBキーは **`/<4文字ゲームID>/<ファイル>`** とし、`dlc/` は原本C++の物理格納場所の概念にとどめる。ゲームIDはC++版に準じ英字4文字、UIでは大文字化する。`_list.txt` はC++のcount/listと同じく空行を除きCRLFの一覧を返し、持ち込み時にCR単独・CRLF・LFも行区切りとして処理する。すでに書いた `dlc/<game>/...` のコードはこの方針へ修正する。
- 現在: `web/file-store.js` のIndexedDB API（put/get/list/remove/readText/writeText）と `web/file-explorer.js` のFile Explorerタイル（ファイル/フォルダD&D、UTF-8編集、ダウンロード、削除）を追加。IndexedDBキーは `/YDQJ/_list.txt` 型、WFCハンドラは要求時にDBを再読込みする。C++由来の `nwc.crt` を含むSSLv3 CertificateチェーンとRC4-SHA/MD5・HTTP・DNS/DHCPのNode単体テストは計10件成功。**ブラウザでのデバッグ・ROM確認はまだ行っていない。** 直近の編集済みディレクトリをCodespaceへ転送しただけでビルドは未起動。

## ビルド着手条件（2026-09-27 再確認）

- ユーザーの再指示: `sizisilyo.txt`、`HANDOFF.md`、本計画、`WORK_DETAILS.md` の残計画を全部実装し終える前にビルドへ進まない。直近の転送や単体JSチェックはビルドではない。ビルドを編集確認のループに使わない。
- 未了: instruction単位の真のstep/step over/run until、ARM9/7 exec・read・write breakpointとcallback・disassembly/call stack、入力シーケンス・記録再生・wait系/フレーム比較・Save/Stateのブラウザ永続化、16台を含む動作/通信の実証、LocalMP/Wi-Fi独立性・WebMCP全toolとの接続、音声など。追加されたDQ9同一オリジン証明書、TCP再送、File Explorerの画面実動も未検証。ひとつでも未実装なら完成とは記載しない。Web上でのデバッグは今回禁止なのでブラウザ動作の検証はユーザーの解禁後に行う。
- 命令デバッグ調査: `ARM.cpp` のARM9/7 `Execute()` がinterpreter各命令を実行し、`NDS::RunFrame` がその外側で両CPUとGPU/timerをスケジュールする。途中で単純にRunFrameを終了するとGPU.StartFrame/TotalScanlinesなどを破壊するため禁止。安全な方向は命令境界で実行pthreadを駐車し、core mutexを一時的に解放してJSの状態観測・操作を許し、同じRunFrameに戻すこと。reset/ROM再ロード/State復元時は駐車を解除して既存フレームを安全に終了させてから破壊操作へ移る必要がある。watchpointは実CPUのDataRead/Write境界にhookし、frontendのメモリ表示からの読み書きでは誤発火させない。
- 実装進捗（未ビルド）: ネイティブのフレーム境界での入力シーケンス再生と入力マスク操作の記録、`inputSequence`/`startInputRecording`/`stopInputRecording`/`getInputRecording`/`stopInputSequence` を追加。reset/ROM/State切替時は予定入力を破棄。`waitFrames`/`waitMemory` はscript-service層で非同期待機し、待機中も同一instanceのネットワーク返信・入力を塞がず、実行中の待機操作のoperationIdキャンセルを受け付ける方向へ拡張。
- ブラウザ保存（未ビルド/ブラウザ未検証）: `web/session-store.js` にinstance単位のSaveと10個のState slotをIndexedDB保存する経路を追加。`saveStateToBrowser`/`loadStateFromBrowser`/`saveSaveToBrowser`/`loadSaveFromBrowser`/`listBrowserStates` は実際のnative export/importとDBトランザクション完了まで待つ。画面基準保存/差分の `captureFrame`/`compareFrames` も追加し、画面またはStateタイルから利用できる。ブラウザの再起動後・異なるROMでの復元契約や16台同時実動は未検証。
- コアデバッグ作業中（未ビルド）: Web専用interpreter hookをチェックアウト済み `melonDS_w/src/ARM.cpp`・`CP15.cpp` の各命令境界とDataRead/Writeに直接追加。`port.cpp` は命令境界で対象pthreadを駐車しcoreMutexを解放してレジスタ/メモリを観測可能にする、exec/read/write breakpoint・instruction step・runUntilのnative操作とイベントringを実装中。JS Worker側のawait可能なdebugger操作、独立WebMCP tool、永続Workerのbreakpoint callbackも接続中。**ビルドも実機検証も未了で、deadlock/フレーム破棄時のstate整合は監査が必要**。不要な `patch-core.py` とbuild.shの差分適用はユーザーの指摘を受け撤去した。ビルド対象Codespaceへは実装がまとまってからチェックアウト済みサブモジュールの変更を反映する。外部DeSmuME checkoutには依存しない。
- 続行中（未ビルド）: 両CPUのexec/read/write breakpoint一覧・命令step/stepOver/runUntil・イベント通知、推定コールトレース、ARM/Thumb簡易逆アセンブラを接続。永続Workerのread/write/exec登録・メモリ/レジスタ旧RPCアダプタ・callbackのrelease/cleanupを接続中。SPUの48kHz stereoをinstanceごとにWasmからコピーし、画面タイルのユーザー操作でWebAudio再生する経路を追加。主RAM/共有WRAM/ARM7 WRAMのメモリ検索はWorkerを定期的にyieldし、実行中のoperationId取消を受け付け、batchは非同期命令も順番にawaitする。`web/virtual-network.js` のTCPは未ACKフレームの再送とサービス解除時のタイマー破棄を追加。これらは**ソース実装のみ**で、実機/ブラウザ確認が許可されるまでは完成判定をしない。
- 追加の整合措置（未ビルド）: 命令中断位置でStateを保存する場合、途中フレームのシリアライズを避けるため、そのフレームを新規debug trapなしで完走して実フレーム境界で保存し、保存完了まで同期する。Stateロードは命令中断中のframeを終了してから復元する。ネットワーク backendをinstance単位で `virtual`/`disabled` に切り替えるAPIとlogger UIを追加、coreMutex+NetLock完了後に返す。ブラウザに保存したSave/Stateは同一ROMのSHA-256と照合してから復元する。WebMCP各toolへ主パラメータの個別スキーマを追加した。これらの実行結果・性能・スレッド停止性は**未検証**。ユーザー指示により全計画の実装が済むまでビルドしない。

## 2026-09-27 作業終了時点（次回はここから）

- ユーザーが「今日はここまで」と指示したため、作業をここで停止。Webブラウザによるデバッグ・ROM動作検証は実施せず、新規pthread/デバッガC++変更後のビルドも**一度も実施していない**。既存の `web/dist/melonds.*` は古い逐次実行版で、現ソースのAPIと一致しない。gitコマンドは使用しない。
- 今回の主なソース変更: `webassembly/port.cpp` のinstance別runner・native debugger停止/イベント・入力シーケンス・メモリfreeze・SPU音声・Stateのフレーム境界保存、`melonDS_w/src/{ARM.cpp,CP15.cpp}` の実インタプリタhook、`web/engine.worker.js` のframe/audio/デバッグ/キャンセル/入力経路、`web/script-service.js` のWorker callbackとawait、File Explorer/IndexedDB、DQ9仮想LAN・SSLv3・DLC・証明書生成、WebMCP個別schema、UI。**これらは実装中の未検証ソースであり、完成宣言しない。**
- Node単体テスト `node --test web/tests/*.test.js` は最新の追加テストの直前に10件成功。最後に `web/tests/api.test.js` へwaitFramesのキャンセル/入力共存テストを追加したが、その追加後の再実行はしていない。新しいJSを含む最終静的構文確認も未実施。ユーザー指示に従い次回も編集ごとのビルドは行わない。
- 同一オリジン証明書: 原本workflowの `WII_NWC_1_CERT.p12` から `nwc.crt` を抽出し、原本仕様のRSA1024/SHA1 server.crtを生成する `web/dq9/generate-certs.sh` と配布CIを実装。`registerDq9WfcFromSameOrigin` が `/web/dq9/certs/` 相対URLからserver.crt/server.key/nwc.crtを取得し、SSLv3 Certificateは **server.crt→元nwc.crt** の順で送る。実際の証明書生成・同一オリジン配信とDS接続は未実施。`web/dq9/certs/` は現ローカル作業フォルダにまだ生成していない。
- File Explorer: 独立タイル `files`、ドラッグ＆ドロップ/フォルダ選択/UTF-8編集/ダウンロード/削除、API `melondsFiles`。仮想パスはユーザー指定の **`/<4文字ゲームID>/<ファイル>`**、例 `/YDQJ/_list.txt`。IndexedDBからWFC要求時に読み込む。`_list.txt` はCR/CRLF/LFをCRLFへ正規化してcount/listに使用。実際のブラウザUI/IndexedDB動作は未確認。
- Codespace `organic-fishstick-wrjpjx79qjwc5qgr` には途中段階の `web/` と `webassembly/` をディレクトリ単位で転送したが、その後多数の編集を加えており**リモートは現在のローカルと不一致**。編集済み `melonDS_w/src` はリモートへ転送していない。転送する時は `gh codespace cp -e` 必須、ビルドを行う時は `build-async.sh` を非同期起動。ユーザーは全計画の実装を終える前のビルドを禁止したので、今は起動しない。不要なPython差分適用スクリプトは削除済み。
- 次回の最優先は **ビルドではなくコード整合の静的監査**: `port.cpp` のデバッガ駐車と `abortActiveFrame` のlock順・停止境界、State checkpoint/復元、`ARM.cpp`/`CP15.cpp` のhook配置、CMake exportsとWorker呼出しの一致、永続Worker breakpoint callback release、ネットワーク/DQ9証明書とFile Explorerのデータフロー。フレーム/通信/16台/ROM/ブラウザの実動はユーザーがWebデバッグを許可するまで未確認として保持する。残作業は本計画の「実施状況」と「ビルド着手条件」に従う。

## UI設計の判断（指定interface-design指針）

- 誰が何をするか: 複数台の通信・CPU状態を突き合わせる開発者が、一つの作業台で対象機を切り替え、raw packetやレジスタを観測する。
- 領域の語彙: デュアルスクリーン、ARM9/ARM7、パケット、タイムスタンプ、インスタンス番号、トレース、メモリマップ。
- 色の出典: 開発室の暗いモニタ、液晶の黒、基板の深緑、蛍光インジケータ、銀色の計測器、橙の警告灯。彩度を抑えた暗色を基礎に蛍光緑は操作可能/接続のみに使う。
- 特徴: 画面と計測器が同じ「ドッキング可能なタイル」で、ヘッダに対象instance/CPUを明示する。
- 避ける定番: 16台×全ツールの固定巨大グリッド、カラフルな汎用管理画面、API対象を現在選択に暗黙追従させる設計。
- 密度: 4px基準、ツール内部12px、タイル間16px。monoは数値/hexだけ。控えめな境界線で階層化し、実データを焦点にする。
