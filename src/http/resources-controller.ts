import { realpath, stat } from "node:fs/promises";
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Resource } from "../catalog/domain/resource.js";
import { ResourceRepository } from "../catalog/domain/resource-repository.js";
import { inspectRemote } from "../catalog/infrastructure/inspect-remote.js";
import { McpOAuth } from "../catalog/infrastructure/mcp-oauth.js";
import { DEFAULT_DOCKERFILE } from "../sessions/domain/default-dockerfile.js";

@Controller("api/resources")
export class ResourcesController {
  constructor(
    @Inject(ResourceRepository) private readonly catalog: ResourceRepository,
    @Inject(McpOAuth) private readonly oauth: McpOAuth,
  ) {}

  @Get()
  async list() {
    const resources = await this.catalog.list();
    const mcps = await Promise.all(
      resources.mcps.map(async (mcp) => ({
        ...mcp,
        oauthConnected: Boolean(
          mcp.url && (await this.oauth.connected(mcp.url)),
        ),
      })),
    );
    return { ...resources, mcps };
  }

  @Get("default-dockerfile")
  defaultDockerfile() {
    return { content: DEFAULT_DOCKERFILE };
  }

  @Get(":id/connection")
  async connection(@Param("id") id: string, @Query("tools") tools?: string) {
    const server = (await this.catalog.list()).mcps.find(
      (mcp) => mcp.id === id,
    );
    if (!server?.url) throw new Error("Select a saved remote MCP server.");
    return inspectRemote(
      server.url,
      await this.oauth.accessToken(server.url),
      tools === "1",
    );
  }

  @Post(":id/connect")
  async connect(@Param("id") id: string, @Req() request: Request) {
    const server = (await this.catalog.list()).mcps.find(
      (mcp) => mcp.id === id,
    );
    if (!server?.url) throw new Error("Save an MCP URL before connecting.");
    if (
      !server.url.startsWith("https:") &&
      !/^(localhost|127\.0\.0\.1)$/.test(new URL(server.url).hostname)
    )
      throw new Error("Use HTTPS to connect this MCP server.");

    const callback = `http://${request.headers.host}/api/resources/oauth/callback`;
    return { authorizationUrl: await this.oauth.connect(server.url, callback) };
  }

  @Get("oauth/callback")
  async callback(@Query() query: unknown, @Res() response: Response) {
    const { state, code } = z
      .object({ state: z.string().uuid(), code: z.string().optional() })
      .parse(query);

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      await this.oauth.complete(state, code);
      response
        .type("text")
        .send("MCP server connected. Close this tab to return to StuntHog.");
    } catch {
      response
        .status(400)
        .type("text")
        .send("MCP connection failed. Close this tab and try again.");
    }
  }

  @Post()
  async create(@Body() input: unknown) {
    const resource = Resource.create(input);

    await this.validatePath(resource);
    await this.catalog.save(resource);

    return resource.value;
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() input: unknown) {
    const resource = Resource.restore({
      ...z.record(z.unknown()).parse(input),
      id,
    });

    await this.validatePath(resource);
    await this.catalog.save(resource);

    return resource.value;
  }

  @Delete(":kind/:id")
  async remove(@Param("kind") kind: string, @Param("id") id: string) {
    await this.catalog.delete(
      z.enum(["environment", "persona", "skill", "mcp"]).parse(kind),
      z.string().uuid().parse(id),
    );

    return { deleted: true };
  }

  private async validatePath(resource: Resource): Promise<void> {
    const value = resource.value;

    if (value.kind === "skill" && value.filePath) {
      const entry = await stat(await realpath(value.filePath));

      if (!entry.isFile()) throw new Error("Choose an existing skill file.");
    }

    if (value.kind === "environment" && value.workspacePath) {
      const entry = await stat(await realpath(value.workspacePath));

      if (!entry.isDirectory())
        throw new Error("Choose an existing workspace folder.");
    }

    if (value.kind === "environment" && value.dockerfilePath) {
      const entry = await stat(await realpath(value.dockerfilePath));

      if (!entry.isFile()) throw new Error("Choose an existing Dockerfile.");
    }
  }
}
