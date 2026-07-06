// flock — browser-side verifier for the signed PWA asset manifest.
// Loaded by sw.js via importScripts; kept as its own file so the EXACT shipped
// bytes are also loaded and exercised by scripts/pwa-manifest.test.mjs against
// real `ssh-keygen -Y sign` output — the same parity discipline as the native
// golden vectors.
//
// Verifies OpenSSH SSHSIG signatures (PROTOCOL.sshsig) with WebCrypto Ed25519 —
// the same primitive and the same release key that signs the release/<build>
// git tags, so one key-custody story covers both. No dependencies; the whole
// verifier is readable in one sitting on purpose.
self.flockVerify = (() => {
  const te = new TextEncoder()
  const td = new TextDecoder()

  const unarmor = (text) => {
    const m = text.replace(/\r/g, '').match(/-----BEGIN SSH SIGNATURE-----\n([\s\S]*?)-----END SSH SIGNATURE-----/)
    if (!m) throw new Error('not an SSH signature')
    const bin = atob(m[1].replace(/\n/g, ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  }

  // SSH wire format: big-endian uint32 length-prefixed strings.
  const reader = (buf) => {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let off = 0
    const bytes = (n) => { const b = buf.subarray(off, off + n); off += n; return b }
    const u32 = () => { const v = view.getUint32(off); off += 4; return v }
    const str = () => bytes(u32())
    return { bytes, u32, str }
  }

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

  /** Armored SSHSIG → { pubRaw, namespace, hashAlg, sigRaw }. Throws on
   *  anything malformed or non-ed25519. */
  const parseSshSig = (text) => {
    const r = reader(unarmor(text))
    if (td.decode(r.bytes(6)) !== 'SSHSIG') throw new Error('bad magic')
    const version = r.u32()
    if (version !== 1) throw new Error(`unsupported SSHSIG version ${version}`)
    const pub = reader(r.str())
    const namespace = td.decode(r.str())
    r.str() // reserved
    const hashAlg = td.decode(r.str())
    const sig = reader(r.str())
    if (td.decode(pub.str()) !== 'ssh-ed25519') throw new Error('not an ed25519 key')
    const pubRaw = pub.str()
    if (td.decode(sig.str()) !== 'ssh-ed25519') throw new Error('not an ed25519 signature')
    const sigRaw = sig.str()
    return { pubRaw, namespace, hashAlg, sigRaw }
  }

  // What ed25519 actually signed (PROTOCOL.sshsig):
  //   "SSHSIG" || string(namespace) || string(reserved) || string(hashAlg) || string(H(message))
  const signedPayload = (namespace, hashAlg, msgHash) => {
    const ns = te.encode(namespace)
    const ha = te.encode(hashAlg)
    const out = new Uint8Array(6 + 4 + ns.length + 4 + 4 + ha.length + 4 + msgHash.length)
    const view = new DataView(out.buffer)
    let off = 0
    out.set(te.encode('SSHSIG'), off); off += 6
    view.setUint32(off, ns.length); off += 4; out.set(ns, off); off += ns.length
    view.setUint32(off, 0); off += 4 // reserved: empty string
    view.setUint32(off, ha.length); off += 4; out.set(ha, off); off += ha.length
    view.setUint32(off, msgHash.length); off += 4; out.set(msgHash, off)
    return out
  }

  const sha256Hex = async (subtle, bytes) => hex(new Uint8Array(await subtle.digest('SHA-256', bytes)))

  /** 'ok' | 'bad' | 'not-a-signature' | 'unsupported' — never throws.
   *  'not-a-signature': the bytes aren't an SSHSIG envelope at all — e.g. an
   *  SPA host falling back a missing .sig to index.html. That is "no signature
   *  shipped" (treat like absent), NOT a cryptographic rejection; 'bad' is
   *  reserved for a real SSHSIG that fails verification. 'unsupported' means
   *  this browser's WebCrypto lacks Ed25519; the caller must skip QUIETLY — a
   *  missing capability is not evidence of tampering. */
  const verifyManifestSig = async (subtle, manifestBytes, sigText, expectedPubHex, expectedNamespace) => {
    let parsed
    try { parsed = parseSshSig(sigText) } catch { return 'not-a-signature' }
    if (hex(parsed.pubRaw) !== expectedPubHex) return 'bad'
    if (parsed.namespace !== expectedNamespace) return 'bad'
    if (parsed.hashAlg !== 'sha512' && parsed.hashAlg !== 'sha256') return 'bad'
    try {
      const msgHash = new Uint8Array(await subtle.digest(parsed.hashAlg === 'sha512' ? 'SHA-512' : 'SHA-256', manifestBytes))
      const key = await subtle.importKey('raw', parsed.pubRaw, { name: 'Ed25519' }, false, ['verify'])
      return (await subtle.verify('Ed25519', key, parsed.sigRaw, signedPayload(parsed.namespace, parsed.hashAlg, msgHash))) ? 'ok' : 'bad'
    } catch {
      return 'unsupported'
    }
  }

  return { parseSshSig, verifyManifestSig, sha256Hex }
})()
