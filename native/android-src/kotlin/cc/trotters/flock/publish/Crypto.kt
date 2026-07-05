package cc.trotters.flock.publish

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

fun hmacSha256(key: ByteArray, msg: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(msg)

fun sha256(msg: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(msg)

private val rng = SecureRandom()

/** AES-256-GCM, 12-byte IV prepended, base64 — canary-kit's aesGcmEncrypt. */
fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray): String {
    require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
    val iv = ByteArray(12).also(rng::nextBytes)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    return Base64.getEncoder().encodeToString(iv + cipher.doFinal(plaintext))
}

fun aesGcmDecrypt(key: ByteArray, contentB64: String): ByteArray {
    require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
    val combined = Base64.getDecoder().decode(contentB64)
    require(combined.size >= 28) { "ciphertext too short" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, combined, 0, 12))
    return cipher.doFinal(combined, 12, combined.size - 12)
}
