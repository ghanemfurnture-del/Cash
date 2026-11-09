import {
  CURRENT_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  HEADER_SIZE,
  MAGIC_BYTES,
} from './types';

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

export interface EncryptOptions {
  iterations?: number;
  formatVersion?: number;
  schemaVersion?: number;
}

export interface DecryptOptions {
  iterations?: number;
}

/**
 * Standard Arabic Error Messages as defined in docs/backup.md
 */
export const BACKUP_ERRORS = {
  WRONG_PASSWORD:
    'كلمة المرور غير صحيحة، أو تم تغيير محتوى الملف المشفر. تعذر فك تشفير النسخة الاحتياطية.',
  TRUNCATED_FILE:
    'ملف النسخة الاحتياطية تالف أو غير مكتمل (بيانات مقطوعة). يرجى التأكد من اكتمال تحميل الملف.',
  TAMPERED_FILE:
    'فشل التحقق من سلامة وأمان النسخة الاحتياطية؛ تم تعديل أو التلاعب ببيانات الملف المشفر.',
  INVALID_FORMAT:
    'تنسيق الملف غير مدعوم؛ الملف المختار ليس نسخة احتياطية صالحة لنظام الخزينة.',
  UNSUPPORTED_FORMAT_VERSION:
    'إصدار تنسيق النسخة الاحتياطية أحدث من هذا التطبيق. يرجى تحديث نظام الخزينة إلى أحدث إصدار ثم إعادة المحاولة.',
  UNSUPPORTED_SCHEMA_VERSION:
    'عدم تطابق في إصدار قاعدة البيانات؛ النسخة الاحتياطية تم إنشاؤها من إصدار أحدث للمخطط لا يدعمه البرنامج حالياً.',
  SAFETY_SNAPSHOT_FAILED:
    'فشل إنشاء لقطة الأمان المؤقتة (قد تكون مساحة التخزين المتاحة على جهازك غير كافية). تم إلغاء عملية الاستعادة فوراً لحماية بياناتك الحالية، ولم يطرأ أي تعديل على قاعدة البيانات.',
};

/**
 * Derives an AES-256-GCM CryptoKey from a password and salt using PBKDF2 (SHA-256).
 */
async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    usages
  );
}

/**
 * Encrypts a plaintext JSON string into the binary .cashbak format.
 *
 * Binary Layout (39-byte header + ciphertext + 16-byte auth tag):
 * 0x00 - 0x06: ASCII "CASHBAK" (7 bytes)
 * 0x07 - 0x08: Format Version (u16 BE)
 * 0x09 - 0x0A: Database Schema Version (u16 BE)
 * 0x0B - 0x1A: PBKDF2 Random Salt (16 bytes)
 * 0x1B - 0x26: AES-GCM Random IV / Nonce (12 bytes)
 * 0x27 - end : AES-256-GCM Ciphertext + 16-byte Tag
 */
export async function encryptBackupPayload(
  plaintextJson: string,
  password: string,
  options?: EncryptOptions
): Promise<Uint8Array> {
  if (!password || password.length === 0) {
    throw new Error('كلمة المرور مطلوبة لتشفير النسخة الاحتياطية.');
  }

  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const formatVersion = options?.formatVersion ?? CURRENT_FORMAT_VERSION;
  const schemaVersion = options?.schemaVersion ?? CURRENT_SCHEMA_VERSION;

  // Generate cryptographic random salt (16 bytes) and IV (12 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Build 39-byte header
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  // Magic bytes "CASHBAK"
  const enc = new TextEncoder();
  header.set(enc.encode(MAGIC_BYTES), 0);

  // Format & Schema version in Big-Endian u16
  view.setUint16(7, formatVersion, false);
  view.setUint16(9, schemaVersion, false);

  // Salt & IV
  header.set(salt, 11);
  header.set(iv, 27);

  // Derive AES-GCM Key via PBKDF2
  const key = await deriveAesKey(password, salt, iterations, ['encrypt']);

  // Encrypt plaintext with Header passed as Authenticated Additional Data (AAD)
  const plaintextBytes = enc.encode(plaintextJson);
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as any,
      additionalData: header as any,
      tagLength: 128,
    },
    key,
    plaintextBytes
  );

  const ciphertextWithTag = new Uint8Array(encryptedBuffer);

  // Combine header + ciphertext
  const result = new Uint8Array(HEADER_SIZE + ciphertextWithTag.byteLength);
  result.set(header, 0);
  result.set(ciphertextWithTag, HEADER_SIZE);

  return result;
}

export interface UnpackedHeader {
  formatVersion: number;
  schemaVersion: number;
  salt: Uint8Array;
  iv: Uint8Array;
  headerBytes: Uint8Array;
}

/**
 * Validates and unpacks the 39-byte binary header from raw backup bytes.
 * Throws specific Arabic errors if corrupt, tampered or incompatible.
 */
export function unpackAndValidateHeader(bytes: Uint8Array): UnpackedHeader {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(BACKUP_ERRORS.TRUNCATED_FILE);
  }

  const headerBytes = bytes.slice(0, HEADER_SIZE);
  const dec = new TextDecoder('ascii');
  const magic = dec.decode(headerBytes.slice(0, 7));

  if (magic !== MAGIC_BYTES) {
    throw new Error(BACKUP_ERRORS.INVALID_FORMAT);
  }

  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const formatVersion = view.getUint16(7, false);
  const schemaVersion = view.getUint16(9, false);

  if (formatVersion > CURRENT_FORMAT_VERSION) {
    throw new Error(BACKUP_ERRORS.UNSUPPORTED_FORMAT_VERSION);
  }

  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(BACKUP_ERRORS.UNSUPPORTED_SCHEMA_VERSION);
  }

  const salt = headerBytes.slice(11, 27);
  const iv = headerBytes.slice(27, 39);

  return {
    formatVersion,
    schemaVersion,
    salt,
    iv,
    headerBytes,
  };
}

/**
 * Decrypts binary .cashbak bytes with password and returns the plaintext JSON string.
 */
export async function decryptBackupPayload(
  bytes: Uint8Array,
  password: string,
  options?: DecryptOptions
): Promise<string> {
  if (!password || password.length === 0) {
    throw new Error(BACKUP_ERRORS.WRONG_PASSWORD);
  }

  const { salt, iv, headerBytes } = unpackAndValidateHeader(bytes);
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;

  // The rest of the file is ciphertext + 16-byte tag
  const ciphertextWithTag = bytes.slice(HEADER_SIZE);
  if (ciphertextWithTag.byteLength < 16) {
    // Needs at least a 16-byte GCM tag
    throw new Error(BACKUP_ERRORS.TRUNCATED_FILE);
  }

  let key: CryptoKey;
  try {
    key = await deriveAesKey(password, salt, iterations, ['decrypt']);
  } catch {
    throw new Error(BACKUP_ERRORS.WRONG_PASSWORD);
  }

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as any,
        additionalData: headerBytes as any,
        tagLength: 128,
      },
      key,
      ciphertextWithTag as any
    );

    const dec = new TextDecoder('utf-8');
    return dec.decode(decryptedBuffer);
  } catch (err: any) {
    // In AES-GCM, tag mismatch occurs for wrong password OR tampered ciphertext / header
    throw new Error(BACKUP_ERRORS.WRONG_PASSWORD);
  }
}
