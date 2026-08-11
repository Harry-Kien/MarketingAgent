const FORBIDDEN_DEPS = [
  "prisma",
  "@prisma/client",
  "n8n",
  "dify",
  "autogen",
  "inngest",
  "@temporalio/client",
  "@temporalio/worker",
  "ioredis",
  "redis",
  "bullmq",
];

const FORBIDDEN_PATH =
  /(^|\/)(billing|subscription|signup|sign-up|provisioning|marketplace|white-label|whitelabel)(\/|\.)/i;

export function findRangeVersions(pkg) {
  const out = [];
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      if (typeof version === "string" && /^[\^~]/.test(version)) out.push(`${name}@${version}`);
    }
  }
  return out;
}

export function findForbiddenDeps(pkg) {
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  return names.filter((n) => FORBIDDEN_DEPS.includes(n));
}

/** Only source paths are checked. docs/ is exempt: the ADRs discuss these words. */
export function findForbiddenScope(paths) {
  return paths.filter((p) => !p.startsWith("docs/") && FORBIDDEN_PATH.test(p));
}
