// Which build is running: the image's git sha (`sha-<short>`, set by CI as the HEARTH_VERSION build
// argument, Dockerfile.prod), or `dev` when run from a checkout. Every /api response and /healthz
// report it, so the client can tell when the server changed under an open page.
export const VERSION = process.env.HEARTH_VERSION || 'dev';
