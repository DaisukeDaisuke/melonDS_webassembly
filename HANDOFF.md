# 次チャットへの引き継ぎ（melonDS WebAssembly Web Debugger）

## 今回の作業と条件

- 原本仕様 `sizisilyo.txt` を最優先し、UIは `interface-design/.claude/skills/interface-design/SKILL.md` を参照する。見た目のタイルだけで19完成条件を達成したと判断しない。
- ユーザー指定: **このチャットでROM動作確認やテストをしない**。ROM実動確認は次の新規チャットの担当者へ引き継ぐ。ビルドは `webassembly/build.sh` を GitHub Actions (`ubuntu-26.04`) から実行する。Codespaceの `gh codespace cp` には必ず `-e` を付ける。データ転送はフォルダ単位。
- DeSmuME原本を別checkoutするActions依存は削除。隔離Worker原本、ハッシュ監査ポリシー、npm lock、LICENSE を `web/sandbox/upstream/` にディレクトリ単位でコピー済み。元の用途と保守方法は `web/sandbox/upstream/PROVENANCE.md`。AIへのWebMCP出力は原本コピーの `compact-output.js` による簡潔なテキスト（JSON本文は送らない）。

## 構成

| 場所 | 内容 |
|---|---|
| `webassembly/build.sh` / `CMakeLists.txt` | Emscripten Wasmビルド。Qt・JIT・OpenGL無効、現forkのコンパイル制約でGDB stub有効、core/teakraとも `-pthread`。成果物は `web/dist/melonds.js`, `.wasm`, `.worker.js`。 |
| `webassembly/port.cpp` / `platform.cpp` / `virtual-net.h` | 16個のNDS、共有LocalMP、エミュレーション呼び出し、画面、ROM/Save/State/メモリ/CPU、Platform userdata、NetDriver raw Ethernetキュー。 |
| `melonDS_w/src/net/LocalMP.{h,cpp}` | LocalMPの送受信を固定長ringへコピー。通信FIFOは変更せず、ログ超過は観測記録だけ破棄する。 |
| `web/engine.worker.js` / `backend.js` / `api.js` | Wasm Worker分離、完了返信付きRPC、明示的instanceId、同一instance操作の順序保証。未実装の命令step・breakpoint等はエラーで返す。 |
| `web/index.html` / `app.js` / `style.css` / `layout.js` | 画面とデバッグ系の独立タイル、Gridと自由配置、リサイズ・Drag & Drop・localStorage復元。 |
| `web/sandbox/upstream/` / `web/scripts/build-workers.mjs` / `web/script-service.js` | コピーした原本のparser/isolated eval/persistent supervisorとsandboxをハッシュ検証付きでバンドル。melonDS instanceへのRPCをアダプト。現時点でnativeブレークポイントcallbackは未接続。 |
| `web/virtual-network.js` | JSサービスがraw Ethernetを処理し、応答を`Platform::Net_RecvPacket`へ注入する基礎。DNS/TCP/DWCの実サービスはまだ未実装。 |
| `web/webmcp.js` | 個別tool登録。Fileはbase64をBlob化。原本コンパクトテキストで返す。 |

## ビルドと成果物

Codespace `organic-fishstick-wrjpjx79qjwc5qgr` にapt版 Emscripten 3.1.6 が導入済み。ユーザー指示のためSSH内で同期ビルドしない。編集済みディレクトリを転送して `gh codespace ssh -c organic-fishstick-wrjpjx79qjwc5qgr "nohup bash /workspaces/melonDS_webassembly/webassembly/build-async.sh > /dev/null 2>&1 < /dev/null &"`。`webassembly/build.exit` の内容を確認し、失敗した場合だけ `build.log` の末尾を読む。転送例: `gh codespace cp -r webassembly remote:/workspaces/melonDS_webassembly/ -c organic-fishstick-wrjpjx79qjwc5qgr -e`。ビルド結果は `gh codespace cp -r remote:/workspaces/melonDS_webassembly/web/dist web/ -c organic-fishstick-wrjpjx79qjwc5qgr -e`。配布Actionsは `web/sandbox/upstream` の `npm ci --ignore-scripts` 後、同梱の `build-workers.mjs` で原本Workerを生成し、外部DeSmuMEレポジトリをcheckoutしない。

初回構成で `ENABLE_GDBSTUB=OFF` にするとforkの`ARM.cpp`がコンパイルエラー。ONで解消。coreライブラリに`-pthread`がないとWasm共有メモリlinkエラー。CMakeで解消し、当初版のWasmリンクは正常終了。現時点の最新編集はビルド結果を確認すること（これはテストとは別のコンパイル確認）。

## 次の担当者が確認すべきこと（ユーザー指示のROM検証）

1. `PLAN.md`/`WORK_DETAILS.md` と `sizisilyo.txt` を読む。今チャットの未実装項目を完成済みと誤認しない。
2. Wasm/workerのロードにはCOOP/COEPによる`crossOriginIsolated`が必要。`web/coi-serviceworker.js` は静的ホスト向けに設けた。localhost/HTTPSで配信し、初回service worker install時は再読込される。
3. 再配布可能なホームブリューROMでインスタンス0の画面とROMロードを確認。Save/Stateと画面表示を検証。ROMや個人データの本文をチャット／リポジトリへ出さない。
4. 2台LocalMPの実ゲーム通信を検証し、`Local Communication Logger` の実packet TX/RX、SenderID、受信先、raw bytesを照合。最大16台で同時運転、状態・入力の分離とFPSを確認。現在は全インスタンスを単一Wasm Workerが順に進めるため、ブロッキング受信とLocalMPタイミングが課題になり得る。
5. Wi-Fiが `Net_SendPacket` / `Net_RecvPacket` を通り、raw loggerに記録されることを確認。`dq9_micro_dwc_server_emulator.cpp-main` は参照であり、DNS/TCP/HTTP/DWC互換サービスは追加実装が必要。
6. 元のscript supervisor/isolated Workerについて起動・登録・停止・MCP・callbackをブラウザで検証し、失敗時のqueue/timeout/cleanupを整合させる。native exec/read/write breakpoint hookがないため現在のbreakpoint callbackは拒否する。

## 残作業の優先順

1. ARM9/ARM7の真のinstruction step / step over / run until / exec-read-write breakpointを、melonDSインタプリタとNDS schedulerの停止・再開契約を壊さず接続。中途半端なフレームstepをinstruction stepと呼ばない。persistent Workerのbreakpoint callbackへ繋ぐ。
2. `web/engine.worker.js` のframe駆動とLocalMPの待ち合わせタイミングを実機で検証し修正。16台でも処理・表示の混線を起こさない。
3. 実際のEthernet経路上でDNS/ARP/UDP/TCP/HTTPとDWC認証・ダウンロードを行うブラウザ内サービスを実装。JSが直接ゲーム結果を捏造しない。
4. メモリ検索・凍結を拡充、Save/State browser永続化、入力記録・再生、wait/batch/キャンセル、音声、scriptイベント契約とWebMCP各toolの結果詳細を整える。

テスト結果を推測で記入しない。今回のチャットではユーザーの後続指示に従いROM確認もテストも実施していない。
