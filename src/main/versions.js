// Planlamadan önce kullanılacak kütüphanelerin güncel sürümlerini npm kayıt defterinden alır.
// Gemini'nin eğitim verisindeki eski API'lerle (ör. Tailwind 3, Zod 3) şartname yazmasını önler.
const REGISTRY = 'https://registry.npmjs.org';

// Paket → isteğin/stack'in metninde geçtiğini gösteren ifade.
const CANDIDATES = [
  ['next', /next\.?js|\bnext\b/i],
  ['react', /\breact\b|next\.?js|vite/i],
  ['typescript', /typescript|\bts\b/i],
  ['tailwindcss', /tailwind/i],
  ['zod', /\bzod\b/i],
  ['vitest', /vitest|vite/i],
  ['@playwright/test', /playwright|e2e/i],
  ['vite', /\bvite\b/i],
  ['prisma', /prisma/i],
  ['drizzle-orm', /drizzle/i],
  ['@nestjs/core', /nest\.?js|\bnest\b/i],
  ['express', /\bexpress(\.js)?\b/i],
  ['fastify', /\bfastify/i],
  ['react-hook-form', /react.?hook.?form/i],
  ['@tanstack/react-query', /tanstack|react.?query/i],
  ['zustand', /zustand/i],
  ['motion', /motion|framer|animasyon|animation/i],
  ['eslint', /eslint|lint/i],
  ['vue', /\bvue\b/i],
  ['nuxt', /\bnuxt/i],
  ['svelte', /\bsvelte/i],
  ['astro', /\bastro\b/i],
  ['bullmq', /bullmq/i],
  ['next-auth', /next.?auth|auth\.js/i],
  ['lucide-react', /lucide/i],
  ['recharts', /recharts|\bcharts?\b/i],
  ['better-sqlite3', /sqlite/i],
  ['turbo', /turborepo|\bturbo\b/i],
];

async function latest(pkg, signal) {
  const url = `${REGISTRY}/${pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)}/latest`;
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data?.version === 'string' ? data.version : null;
}

// Metinde (istek + ürün tanımı + stack) geçen teknolojilerin güncel sürümleri: { paket: sürüm }
async function currentVersions(text, { signal } = {}) {
  const pkgs = CANDIDATES.filter(([, re]) => re.test(text)).map(([p]) => p);
  const out = {};
  await Promise.all(
    pkgs.map(async (p) => {
      try {
        const v = await latest(p, signal);
        if (v) out[p] = v;
      } catch {
        /* ağ yoksa sürümsüz devam */
      }
    })
  );
  return Object.fromEntries(pkgs.filter((p) => out[p]).map((p) => [p, out[p]]));
}

module.exports = { currentVersions, CANDIDATES };
