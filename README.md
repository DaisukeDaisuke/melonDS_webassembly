# melonDS WebAssembly Workbench

マルチインスタンスのmelonDSと独立したデバッグタイルを扱うWeb作業空間。仕様は `sizisilyo.txt`、調査・実装状況は `PLAN.md` と `WORK_DETAILS.md`、次チャットへの検証引き継ぎは `HANDOFF.md` を参照してください。仕様の全機能はまだ完成していません。

## ビルド

EmscriptenのあるLinux環境で `melonDS_w` submoduleを初期化してから `bash webassembly/build.sh`。成果物は `web/dist/melonds.js`、`.wasm`、`.worker.js`。また `web/sandbox/upstream/` で `npm ci --ignore-scripts` を実行し、プロジェクトルートから `node web/scripts/build-workers.mjs` で原本の隔離Workerをビルドします。GitHub Actions (`.github/workflows/build-web.yml`) が同じ処理を実行して `web/` をartifactとして公開します。外部DeSmuMEリポジトリのcheckoutは不要です。

ローカルで見る場合は、`web/` をHTTP(S)で配信してください。pthread対応Wasmにはクロスオリジン分離が必要です。静的ホスト向けに同一オリジンの `coi-serviceworker.js` を用意しています。

## JavaScript API

`window.melonds` は明示的な `instanceId: 0..15` で操作します。例: `await melonds.createInstance({ instanceId: 2 })`、`await melonds.loadRom({ instanceId: 2, file })`、`await melonds.getRegisters({ instanceId: 2, cpu: 'ARM9' })`。複数機への同一ROMは `loadRomMany({ instanceIds: [0, 1], file })`。各PromiseはWorker内のmelonDS呼び出し完了後に解決します。未実装の命令step・breakpoint・DWCサービス等は明確なエラーを返します。

仮想ネットワークは `melondsVirtualNetwork.register({ instanceId: 2, onFrame: async (ethernetFrame) => replyFrame })` でraw Ethernetフレームのサービスを登録できます。ゲームが送信したフレームだけが対象で、応答もmelonDSの `Net_RecvPacket` に注入されます。DNS/TCP/HTTP/DWCは別途プロトコル実装が必要です。
