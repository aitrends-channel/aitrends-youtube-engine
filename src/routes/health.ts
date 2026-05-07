import { Express } from "express";

export function setupHealthRoutes(app: Express) {
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  app.get("/health/ready", (req, res) => {
    res.json({
      ready: true,
      timestamp: new Date().toISOString(),
    });
  });
}
