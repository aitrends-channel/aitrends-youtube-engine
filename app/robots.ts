import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/login", "/signup", "/forgot-password"],
      disallow: ["/dashboard/", "/projects/", "/demo/", "/setup/", "/admin/", "/api/"],
    },
    sitemap: "https://app.heclus.io/sitemap.xml",
  };
}
