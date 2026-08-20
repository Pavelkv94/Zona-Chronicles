/**
 * Тестовые фикстуры для `scan-secrets.test.ts` (OPS-03).
 *
 * Позитивные образцы построены конкатенацией, чтобы искомая подстрока не лежала
 * буквально в исходном тексте этого файла: сам `scan-secrets.ts` сканирует
 * git-tracked содержимое `tools/**`, и буквальный литерал самопородил бы находку
 * в собственном репозитории. `security/policy.json` дополнительно исключает
 * `tools/security-scan/src/__fixtures__/**` через `secret_policy.allowlisted_paths`
 * как defense-in-depth.
 */

const PEM_HEADER = ['-----BEGIN', ' ', 'RSA PRIVATE', ' ', 'KEY-----'].join('');
const PEM_BODY = 'MIIEowIBAAKCAQEAxamplekeymaterialxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PEM_FOOTER = ['-----END', ' ', 'RSA PRIVATE', ' ', 'KEY-----'].join('');

export const PEM_PRIVATE_KEY_SAMPLE = [PEM_HEADER, PEM_BODY, PEM_FOOTER].join('\n');

const AWS_PREFIX = ['AK', 'IA'].join('');
export const AWS_ACCESS_KEY_ID_SAMPLE = `${AWS_PREFIX}EXAMPLEKEY123456`;

const SECRET_WORD = ['ap', 'i_key'].join('');
export const GENERIC_SECRET_ASSIGNMENT_SAMPLE = `const ${SECRET_WORD} = "${'x'.repeat(24)}";`;

export const DOTENV_STYLE_SAMPLE = `SOME_SERVICE_TOKEN=${'y'.repeat(20)}`;

export const CLEAN_SOURCE_SAMPLE = [
  'export const add = (a: number, b: number): number => a + b;',
  '// no secrets here, just arithmetic',
].join('\n');
