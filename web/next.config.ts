import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The build directory is named `.next.nosync` rather than `.next` so that
   * a file-syncing client leaves it alone: iCloud skips anything whose name
   * ends in `.nosync`, and Dropbox honours the same suffix.
   *
   * This is not hypothetical tidiness. A checkout of this repository sat
   * under an iCloud-synced Desktop, where iCloud copied and evicted files
   * underneath Turbopack as it wrote them. It showed up as a dev server that
   * bound its port and then hung before printing a banner, as
   * `failed to rename CURRENT.next to CURRENT`, and as duplicate `* 2.*`
   * files that twice broke `tsc`. The build output is regenerable and
   * nobody's backup should contain it, so the exclusion costs nothing even
   * where nothing is syncing.
   *
   * It must stay inside the project directory — Next rejects a `distDir`
   * outside it, and resolving one outside also breaks module resolution for
   * the PostCSS chunks, which load `@tailwindcss/postcss` relative to their
   * own path.
   */
  distDir: ".next.nosync",
};

export default nextConfig;
