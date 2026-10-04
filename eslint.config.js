// Kod denetimi: tanımsız ad, kullanılmayan değişken, erişilemeyen kod gibi gerçek hataları yakalar (biçim kuralı yok).
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  // "const { gizli, ...kalan } = nesne" bir alanı dışarıda bırakmanın yoludur: kardeş alanlar sayılmaz.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off',
  'no-useless-escape': 'off',
  'no-regex-spaces': 'off',
  // "let x = varsayılan; try { x = … }" kalıbı bilinçlidir.
  'no-useless-assignment': 'off',
  'preserve-caught-error': 'off',
};

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'build/**'] },
  // Ana süreç ve testler: CommonJS + Node.
  { files: ['src/main/**/*.js', 'test/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } }, rules },
  // Arayüz: tarayıcıda ES modülleri (app/); markdown.js klasik betiktir (window.renderMarkdown).
  { files: ['src/renderer/app/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } }, rules },
  { files: ['src/renderer/markdown.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } }, rules },
];
