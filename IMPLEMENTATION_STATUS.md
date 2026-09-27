# 2026-09-28 実装・実測記録

作業対象はローカル melonDS_webassembly。ZIPとdesmume_webassembly-mainは参照のみ。コード変更はlocal MCP経由。新規テスト基盤・サニタイザは追加/実行していない。

## 実装済み（最終確認作業中）
- 実用的な明色UI。小さいヘッダー、ツールパレット、対象切替、一覧/自由配置、位置・サイズ保存。
- ROM個別/一括読込、512MiBまでの読込、同一Retail ROMバッファ共有。
- キーボード/下画面タッチの実コア入力、解除/対象切替時のキー解放。
- loader.js + main.js + melonds.wasm の配布用事前バンドル。pthread/スクリプトWorkerのコードはmainへ内包。
- 現ソースのWasm Releaseビルド成功（Emscripten3.1.6、Codespace、2並列）。初回のweb-debug-hooks.h include不備を修正後に成功。
- webassembly/build.shでネイティブとJSをまとめてビルド。webassembly/serve.pyでpublicのみを公開。

## 実測済み
公開URL: https://organic-fishstick-wrjpjx79qjwc5qgr-8080.app.github.dev/
Codespace: organic-fishstick-wrjpjx79qjwc5qgr
remote source: /workspaces/melonDS_webassembly
remote UI staging: /workspaces/melonDS_webassembly/browser-build
公開サーバーはstaging/publicを8080で配信。
- ChromeのcrossOriginIsolated=true、Wasm初期化成功。
- 指定dq9_new2.nds（268435456bytes）読込・実ゲーム画面描画。
- 指定29_dlcs.savをUIからインポート、エラーなし。ゲーム内データの最終確認は継続中。
- 単一インスタンス約59.98fps（1500ms実測）。
- ARM9 pause/stepでPC020b8538→020b853c、実デバッグ停止イベント。
- Nativeステート保存19285389bytes、ロードでframe5647→3589、pause維持。

## 未完・継続事項（完了扱いしない）
- battle.dstは実データがDeSmuME SState v12。圧縮長2534352、展開長11395687。melonDSネイティブ形式ではない。互換インポート未実装、調査中。
- DLC証明書生成/実通信確認、ローカル通信のゲーム実通信、16台実行確認。
- 各インスタンスのFirmware MAC分離をローカルコードへ反映済み、次回ビルド待ち。
- 最終public成果物のローカルへの戻しは未実施。ローカルweb/distは旧成果物の可能性があり、完成品扱いしない。

## ツール事象
- read_text/nodeチェック引数違いは正規schemaで再試行して成功。
- Chromeの複合ステート確認が一度安全確認エラー。statusとpause/loadStateの通常API確認へ分割して再試行成功。状態ロード自体は上記の実測で成功。
