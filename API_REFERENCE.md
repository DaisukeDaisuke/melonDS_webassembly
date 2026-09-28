# melonDS WebAssembly API

実装: `web/api.js`, `web/engine.worker.js`, `web/script-service.js`, `web/packet-control.js`, `web/webmcp.js`。
変更日: 2026-09-28。既存の実インスタンスに作用するAPIであり、UIだけの疑似動作ではない。

## 1. 共通契約

ブラウザー内では `window.melonds`。WebMCPでは `melonds.<メソッド名>` として個別登録する。
`melonds.toolNames()` が実行中の全メソッド名を返す。
インスタンス操作には必ず `instanceId: 0..15` を指定する。CPU指定は `cpu: 'ARM9' | 'ARM7'`、既定ARM9。
アドレスは符号なし32bitの数値。JSONでは `33554432`、JavaScriptでは `0x02000000` と書ける。
引数はオブジェクト、戻り値はPromise。エラーはrejectする。WebMCPでは `isError` とメッセージを返す。
同一インスタンスの変更は順序化する。破棄・ロード・停止などは実処理の完了後にresolveする。
待機操作は入力やネットワーク応答を妨げない。

```js
const id = 0;
await melonds.pause({ instanceId: id });
const registers = await melonds.getRegisters({ instanceId: id, cpu: 'ARM9' });
console.log(registers);
```

ファイルを使う直接APIでは `file: File | Blob` を渡す。ローカルパス文字列は読めない。
WebMCPでは `fileBase64` にファイルのバイト列を指定する。大きいROMはUIのファイル選択を使うと転送量を減らせる。
ファイル選択はブラウザー内で処理され、公開サーバーへROM/BIOS/SAVをアップロードしない。

## 2. インスタンス・実行・ファイル

| API | 追加引数 / 内容 |
|---|---|
| `createInstance` | `instanceId?`。省略時は空きIDを割当。最大16。 |
| `listInstances` | 引数なし。存在するID一覧。 |
| `destroyInstance` | 指定IDの実行停止、コアと関連スクリプトの破棄完了を待つ。 |
| `status` | `loaded`, `paused`, `frames`, `romBytes`, `sharedRomInstances`, `system`。 |
| `pause`, `resume`, `reset` | 指定インスタンスの実行制御。 |
| `step`, `stepOver`, `smartStep` | `cpu?`。ステップ完了まで待つ。 |
| `runUntil` | `cpu?`, `address`, `timeoutMs?`。実行到達待ち。 |
| `loadRom` | `file`。指定IDにROMをロード。 |
| `loadRomMany` | `instanceIds: number[]`, `file`。同一ROMの読み取り専用実体を共有。対象IDは先に作成する。 |
| `loadSystemFile` | `kind: 'bios7'|'bios9'|'firmware'`, `file`。停止中の適用を推奨。 |
| `loadState` | `file`があればファイルを読込。なければ`slot:0..9`。DeSmuME DSTとネイティブStateに対応。 |
| `saveState` | `slot:0..9`。コアのスロットへ保存。 |
| `exportState` | `slot:0..9`。保存済みスロットをバイト列として返す。 |
| `importSave` | `file`。カートリッジのSAVを取込。ステートとは別。 |
| `exportSave` | SAVのバイト列を返す。 |
| `saveStateToBrowser`, `loadStateFromBrowser` | `name`, `slot?`。ブラウザー内の名前付きState。 |
| `saveSaveToBrowser`, `loadSaveFromBrowser` | `name`。ブラウザー内のSAV。 |
| `listBrowserStates` | 現ROMに紐づく保存一覧。 |

BIOSツールは**ファイル名ではなくサイズ**で自動判定する。BIOS7=16KiB、BIOS9=4KiB、FW=128/256/512KiB。
「次回も使用」はこのオリジンのIndexedDBへ保存し、新規インスタンスに適用する。
`status.system` の `bios7/bios9/firmware` は外部ファイル適用、`nativeBios7/nativeBios9` はコアによる実機BIOS判定。
Stateの復元はStateに含まれるFW状態も戻す。別FWを適用したい場合はState読込の後に行う。

## 3. レジスタ・メモリ・デバッガ

| API | 追加引数 |
|---|---|
| `getRegisters` | `cpu?`。r0..r15/cpsr等。 |
| `setRegister` | `cpu?`, `register: 'r0'..'r15'|'cpsr'`, `value:uint32`。 |
| `readMemory` | `cpu?`, `address`, `length:1..4096`。バイト列。 |
| `writeMemory` | `cpu?`, `address`, `data:byte[]`。 |
| `memorySearch` | `cpu?`, `address?`, `length?`, `pattern:byte[]`, `limit?`。 |
| `memoryFreeze` | `cpu?`, `address`, `data:byte[]`。 |
| `listMemoryFreezes` | 凍結一覧。 |
| `removeMemoryFreeze` | `cpu?`, `address`。 |
| `disassemble` | `cpu?`, `address`, `count:1..256`, `thumb?`。実メモリから逆アセンブル。 |
| `addBreakpoint` | `cpu?`, `type`, `address?`, `length?`。IDを返す。 |
| `removeBreakpoint` | `id`。 |
| `listBreakpoints` | `cpu?`。 |
| `callStack` | `cpu?`, `limit?`。実行履歴由来のレーン。空になったレーンは除去する。 |

UIのレジスタ欄は停止中だけ編集できる16進入力欄。実行中は読み取り専用。
APIでPC/CPSRを変える場合も停止してから実施する。

### ブレークポイントの種類

`execute`:命令実行、`read`:メモリ読取、`write`:メモリ書込、`access`:読取または書込。
これらには`address`が必要。範囲は`length`(既定1、最大4096)。
`dataAbort`, `prefetchAbort`, `undefinedInstruction` はCPU例外で停止し、アドレス指定は不要。
ARM9のData/Prefetch abortはコアの該当例外入口、未定義命令はARM/Thumbデコード経路に接続している。
停止は例外を無効化する意味ではない。再開すれば元の例外処理が続く。

```js
const access = await melonds.addBreakpoint({instanceId:0,cpu:'ARM7',type:'access',address:0x04000130,length:2});
const abort = await melonds.addBreakpoint({instanceId:0,cpu:'ARM9',type:'dataAbort'});
// 終了時
await melonds.removeBreakpoint({instanceId:0,id:access.id});
await melonds.removeBreakpoint({instanceId:0,id:abort.id});
```

## 4. 入力・フレーム・ログ

| API | 追加引数 / 内容 |
|---|---|
| `input` | `key`, `pressed:boolean`。A/B/X/Y/L/R/START/SELECT/UP/DOWN/LEFT/RIGHT。 |
| `touch` | `x:0..255`, `y:0..191`, `pressed:boolean`。 |
| `inputSequence` | `events:[{frame,mask}]`。フレーム指定の入力列。 |
| `repeatInput` | `key`または`keys`, `count`, `pressFrames`, `releaseFrames`。 |
| `stopInputSequence` | 予約入力を停止。 |
| `startInputRecording`, `stopInputRecording`, `getInputRecording` | 入力記録。 |
| `waitFrames` | `frames`, `timeoutMs?`。 |
| `waitMemory` | `cpu?`, `address`, `pattern`, `timeoutMs?`。 |
| `screenshot` | 上下画面のRGBAバイト列と寸法。 |
| `captureFrame`, `compareFrames` | 基準画面の保存と差分。`compareFrames`に`threshold?`。 |
| `localCommLog`, `wifiLog` | `limit?`。表示用ログ。読んだだけでは通信を変更しない。 |

`melonds.subscribe(event => {...})`は解除関数を返す。
主なイベントは `frame`, `audio`, `breakpoint`, `debug-stop`, `local-log`, `wifi-log`, `packet-pending`, `packet-error`, `instance-change`。
大量のフレーム/音声をコンソールへ毎回出力しない。

## 5. 通信の傍受・編集・コミット

Wi-Fi側はDSの仮想Ethernet/IPv4/TCP入力出力、LocalMP側は実コアのローカル通信パケット待ち行列に作用する。
`wifiLog/localCommLog`の表示データの変更とは異なる。既定では傍受は無効で元の経路へ流れる。

### setPacketInterceptor

```js
await melonds.setPacketInterceptor({
  instanceId:0, medium:'wifi', enabled:true, direction:'TX'
});
```

`medium`: `wifi`または`local`。Wi-Fiは`direction:'TX'|'RX'|'both'`、LocalMPは`TX`。
LocalMP受信を変更したい場合は送信元のTXを傍受し、配送先を指定する。
`enabled:false`で解除。保留中のパケットは既定でforward、`pendingAction:'drop'`なら破棄する。
傍受中のパケットは実送信されない。長く保留すればゲーム側の通信タイムアウトが起こり得る。

### pendingPackets / commitPacket

```js
const pending = await melonds.pendingPackets({instanceId:0,medium:'wifi'});
for (const packet of pending) {
  // packet.data はこの通信の実バイト列。必要な位置だけ編集する。
  await melonds.commitPacket({instanceId:0,packetId:packet.packetId,action:'forward',data:packet.data});
}
```

返却: `packetId`, `instanceId`, `medium`, `direction`, `data`, LocalMPでは`packetType`, `timestamp`, `destinationMask`。
`packetId`は不透明IDとして、そのまま渡す。別インスタンスのIDは使用不可。
`commitPacket`の`action`は`forward`/`drop`。データ省略なら元のバイト列、`data:byte[]`または`hex:string`で置換する。
同じパケットは一度だけコミットできる。完了後にPromiseがresolveする。
Wi-Fiフレームは14..2048bytes。フレームのチェックサムを変える編集では呼出側がIP/TCP等を整合させる。
TLS暗号化後の任意変更はTLS検証を通らない。HTTP本文を編集する用途は既存仮想サーバーのHTTPハンドラを使う。

LocalMPの任意引数: `destinationMask:0..65535`, `timestamp`(DS通信タイムスタンプ、非負の安全整数)。
通常パケット最大2376bytes（0x948）、replyは1024bytesまで。元のpacketTypeはcommit時に維持する。
Wi-Fiの任意引数: `destinationInstanceId:0..15`。指定すると元の仮想サーバーではなく、そのインスタンスへRX注入する。

### 配送ルールと注入

```js
// #0のLocalMP出力を#1と#2だけへ。
await melonds.setPacketRoutes({instanceId:0,medium:'local',destinationMask:(1<<1)|(1<<2)});
// 元の全接続先へ戻す。
await melonds.setPacketRoutes({instanceId:0,medium:'local',destinationMask:0xffff});
// #0のEthernet TXを#1のRXへ。MAC/IP/DHCPルーティングは呼出側の責務。
await melonds.setPacketRoutes({instanceId:0,medium:'wifi',destinationInstanceId:1});
await melonds.setPacketRoutes({instanceId:0,medium:'wifi',destinationInstanceId:null});
```

`injectNetworkFrame({instanceId,data})` はWi-Fi RXへEthernetフレーム注入。RX傍受有効時は保留対象になる。
`injectLocalPacket({instanceId,packetType,timestamp,destinationMask?,data? ,hex?})` はLocalMPの送信。
`packetType`下位16bit: regular=0, command=1, reply=2, ack=3。replyでは上位16bitにAID1..15を入れる。
注入は既存のLocalMP FIFOと通知機構を使い、別の通信エミュレーターを作らない。

### 常駐スクリプトを編集ハンドラにする

常駐スクリプトはMCP関数を公開できる。ネットワークのハンドラとしてその関数を指定する。
以下は受信した実パケットを加工せず返す基本形。`packet.hex`を必要な箇所だけ変更することで編集できる。

```js
await melonds.startPersistentScript({instanceId:0,name:'packet-editor',code:`
  let received = 0;
  return {mcps:[{
    name:'rewrite',
    description:'Edit an intercepted packet',
    handler:async packet => {
      received++;
      return {action:'forward',hex:packet.hex};
    }
  },{
    name:'stats',description:'Number of intercepted packets',
    handler:async () => ({received})
  }]};
`});
await melonds.setPacketInterceptor({
  instanceId:0,medium:'wifi',enabled:true,direction:'both',
  handler:{scriptName:'packet-editor',name:'rewrite'}
});
```

ハンドラ引数はパケットのメタデータと`hex`。戻り値`{action:'forward',hex?,destinationMask?,destinationInstanceId?,timestamp?}`で編集してコミット、`{action:'drop'}`で破棄、`{action:'hold'}`で保持。
ハンドラが失敗・タイムアウトした場合は`packet-error`を発行し、パケットを黙って書き換えず保持する。
ハンドラ呼出タイムアウトは3000ms。大量の個別バイトをRPCで往復するよりhexを一度で返す。

## 6. スクリプトとMCP

`runScript({instanceId,code})`:一回実行。
`startPersistentScript({instanceId,name,code,asyncMode?})`:起動完了待ち。
`stopPersistentScript`, `restartPersistentScript`: `instanceId,name`。
`listPersistentScripts({instanceId})`:一覧。
`callPersistentScriptMcp({instanceId,scriptName,name,params?,blocking?,timeoutMs?})`:公開関数の呼出。

常駐Workerには`mcp.call(name,params)`, `memory`, `print`, `printf`, `printhex`, `emu`等を渡す。
`mcp.call`のインスタンスはスクリプトの対象へ固定し、他インスタンスへの越境を認めない。
通常コマンドの戻り値は`{ok:true,value}`。`memory.readbyte/readword/readdword/getregister`は簡易値を返す。
`memory.registerread/write/exec/access(address,callback,{cpu?,length?})`で停止イベントへ接続できる。
`memory.registerexception('dataAbort'|'prefetchAbort'|'undefinedInstruction',callback,{cpu?})`で例外を監視する。
`emu.ontick`, `emu.onstateload`, `emu.onstatesave`はイベント登録。停止完了時はWorkerとBlob URLも破棄する。

`batch({instanceId,commands:[{command,params},...]})`は最大64コマンド。境界の検査は単発APIと共通。
長時間操作には任意の一意`operationId`を付け、`operationStatus({instanceId,operationId})`で状態を見る。
`cancelOperation`はキャンセル可能な操作または未実行操作を対象にし、実際に完了した結果を返す。

## 7. 仮想WFC / DLC

```js
await melondsVirtualNetwork.registerDq9WfcFromSameOrigin({instanceId:0});
await melonds.setNetworkBackend({instanceId:0,backend:'virtual'});
```

`melondsVirtualNetwork.registerDq9Wfc`は`certificatePem/privateKeyPem/chainPem?`とDLC情報を明示指定できる。
標準経路は`server_with_chain.crt`と`server.key`を同一オリジンから読込み、証明書を順番通り送信する。
`setNetworkBackend({backend:'disabled'})`で切断。
DLCは`melondsFiles`/DLCファイルツールのブラウザー内ファイルから配信する。
`conntest`応答は仕様のraw HTTPレスポンスを保ち、通常HTTP整形を通さない。

## 8. 全体保存 .mel

`await melondsWorkspace.export()` → Blob。
`await melondsWorkspace.import(file)` →復元完了。
UIの「全体保存 .mel」から同じ経路を呼ぶ。ROMをハッシュ単位で一度だけ同梱し、通常のコアStateとは別ファイル。
全インスタンス、10スロット、BIOS/FW、停止状態、入力、画面、デバッガ、LocalMP/AP/NetDriver待ち行列、TCP/SSL接続状態、傍受パケット、DLC、配置、ログを同梱する。
命令途中で停止中の場合は既存Stateのフレーム境界へ進めてcheckpointを作るため、保存時にフレーム番号が1進む場合がある。メタデータは保存した実フレームに合わせる。
常駐スクリプトはソース/name/対象を復元するが、任意JS Workerの実行中スタックは復元できないため停止状態にする。
ユーザー定義の通信closureにsnapshot機能がない場合は、黙って除外せず保存を拒否する。
作業中の旧v1/v2 .melと現v3の通信FIFO構造は異なる。旧形式は復元を始める前に拒否する。

## 9. UI設定と公開構成

言語はヘッダーの日本語/English切替。UI要素IDとdata-i18nに対応する文言だけ差し替え、ゲームデータやスクリプトを翻訳しない。
ツール一覧の「…」では項目をドラッグして並べ替え、順序をlocalStorageへ保存する。一覧配置の各パネル右端は横幅変更ハンドルで、1〜4列の幅へ広げられる（狭い画面では表示可能な列数まで）。ドラッグ中はカーソル形状を変更する。
公開物の本体は`loader.js`, `main.js`, `melonds.wasm`。CSS/HTMLとWFC証明書は別リソース。
Service Workerはmain.js/wasmの取得を実行中メモリーだけで共有し、CacheStorageには保存しない。
ビルド内容の識別子が変わるとWorkerを更新する。強制再読み込みでも分離ヘッダーが有効なら起動を待ち続けない。
