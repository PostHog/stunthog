import {
  Injectable,
  type NestInterceptor,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { PostHog } from "posthog-node";
import { PostHogInterceptor } from "posthog-node/nestjs";
import type { CaptureAi } from "./observed-harness.js";

type AnalyticsProperties = Record<string, boolean | number | string | null>;

@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly client: PostHog | null;

  constructor(readonly distinctId: string) {
    const token = process.env.POSTHOG_PROJECT_TOKEN;
    const host = process.env.POSTHOG_HOST;

    this.client =
      token && host
        ? new PostHog(token, {
            host,
            enableExceptionAutocapture: true,
            beforeSend: (event) => ({
              ...event,
              distinctId,
              properties: {
                ...event.properties,
                $device_id: distinctId,
                $is_identified: false,
              },
              options: { ...event.options, process_person_profile: true },
            }),
            logs: {
              serviceName: "stunthog-backend",
              beforeSend: (record) => ({
                ...record,
                attributes: {
                  ...record.attributes,
                  posthogDistinctId: distinctId,
                },
              }),
            },
          })
        : null;
  }

  interceptor(): NestInterceptor {
    return this.client
      ? new PostHogInterceptor(this.client, {
          captureExceptions: true,
          getDistinctId: () => this.distinctId,
        })
      : { intercept: (_context, next) => next.handle() };
  }

  capture(event: string, properties: AnalyticsProperties = {}): void {
    if (!this.client) return;

    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties,
    });
  }

  info(message: string, properties: AnalyticsProperties = {}): void {
    this.client?.logger.info(message, properties);
  }

  captureAi: CaptureAi = (event, properties, timestamp) => {
    try {
      this.client?.captureAi({
        distinctId: this.distinctId,
        event,
        properties,
        timestamp,
      });
    } catch {
      // Instrumentation cannot change a session's result.
    }
  };

  exception(error: unknown, operation: string): void {
    this.client?.captureException(error, {
      distinctId: this.distinctId,
      properties: { operation },
    });
    this.client?.logger.error("Operation failed", { operation });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}
