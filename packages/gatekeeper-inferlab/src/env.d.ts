// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /**
     * The origin of the InferLab central-auth deployment people sign in through: the subjects'
     * issuer. https, or http on a loopback host for local development. Unset or malformed: no
     * sign-in.
     */
    INFERLAB_AUTH_ORIGIN?: string;
    /** The tenant id of the one company this deployment serves. Unset or malformed: no sign-in. */
    INFEROPS_COMPANY?: string;
    /** This gatekeeper's public base URL; its `/oauth` is the redirect URI InferLab registers. */
    BASE_URL?: string;
  }
}
