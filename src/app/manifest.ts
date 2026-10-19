import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Operra Events OS",
    short_name: "Operra",
    description: "Operations platform for event, protocol and VIP invitation agencies",
    start_url: "/select-org",
    display: "standalone",
    background_color: "#f6f5f1",
    theme_color: "#0e5a52",
    lang: "ar",
    dir: "rtl",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
