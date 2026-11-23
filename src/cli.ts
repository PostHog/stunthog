#!/usr/bin/env bun
import "reflect-metadata";
import { CommandFactory } from "nest-commander";
import { CliModule } from "./cli.module.js";
import { loadEnvironment } from "./infrastructure/environment.js";

loadEnvironment();

// Nest Commander builds the CLI context, then the serve command starts the web application.
try {
  await CommandFactory.runWithoutClosing(CliModule, {
    logger: ["error"],
    cliName: "stunthog",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
