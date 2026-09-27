# DQ9 WFC virtual service

`dq9-wfc.js` ports the NAS `/ac`, `/pr` and DLS `/download` responses from
`dq9_micro_dwc_server_emulator.cpp` (MIT license: `LICENSE`). `ssl3.js` is an
independent JavaScript implementation of the SSLv3 RSA/RC4 transport used by
that server. No files are read from the reference project at build or runtime.

Example (after creating the melonDS instance):

```js
const wfc = melondsVirtualNetwork.registerDq9Wfc({
  instanceId: 0,
  certificatePem: serverCertificatePem,
  privateKeyPem: serverPrivateKeyPem,
  chainPem: optionalIntermediateCertificatePem,
  dlc: {
    YDQJ: { '_list.txt': 'item1\ritem2\r', 'item1': new Uint8Array([1, 2]) }
  }
});
// wfc.setDlc('YDQJ', { '_list.txt': ..., ... });
// wfc.unregister();
```

`web/dq9/generate-certs.sh` reproduces the certificate generation steps of the
reference project's `dummy-certs-linux` workflow using the same NintendoCerts
PKCS#12 source, 1024-bit RSA server key, subject, SHA1 signature and chain.
The CI artifact includes `web/dq9/certs/` under the **same origin** as the UI.
For local hosting, run `bash web/dq9/generate-certs.sh` once before serving
`web/`. Then the convenient same-origin loader is:

```js
const wfc = await melondsVirtualNetwork.registerDq9WfcFromSameOrigin({
  instanceId: 0
});
await melondsFiles.writeText({ path: '/YDQJ/_list.txt', text: 'item1\r' });
await melondsFiles.put({ path: '/YDQJ/item1', data: new Uint8Array([1, 2]) });
```

`server.key` is a generated dummy key, loaded by the in-browser SSLv3 server
from this origin. The SSLv3 Certificate message contains both the generated
`server.crt` **and the original PKCS#12-derived `nwc.crt`**, leaf first. The
original PKCS#12 and its signing key are not hosted.
Game content must be provided by the user. The network replies travel through
melonDS `Net_RecvPacket`, not through a ROM patch. This transport has not been
verified with a browser or a DQ9 ROM yet.

The independently movable **File Explorer** tile lets users drop individual
files or a four-letter game ID directory, edit UTF-8 text, download and remove
files. Its IndexedDB paths are `/<GAMEID>/<filename>` (for example
`/YDQJ/_list.txt`). Changes take effect on the next WFC request without
restarting the virtual server. The list accepts CR, CRLF and LF input and is
returned to the DS with CRLF records, as in the original count/list service.
