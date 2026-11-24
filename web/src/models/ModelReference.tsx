import { createContext, type ReactNode, useContext } from "react";
import codexIcon from "../../../images/harnesses/chatgpt.jpg";
import piIcon from "../../../images/harnesses/pi.png";
import { useApi } from "../api.js";
import { Tooltip } from "../Tooltip.js";
import type { Harness } from "../types.js";

const Catalog = createContext<Harness[]>([]);
const brands: Record<
  string,
  { title: string; icon: string; fallback: string }
> = {
  codex: {
    title: "Codex",
    icon: codexIcon,
    fallback: "C",
  },
  claude: {
    title: "Claude Code",
    icon: "https://claude.ai/favicon.ico",
    fallback: "C",
  },
  opencode: {
    title: "OpenCode",
    icon: "https://opencode.ai/favicon.ico",
    fallback: "OC",
  },
  pi: { title: "Pi", icon: piIcon, fallback: "π" },
};

export function ModelCatalog({ children }: { children: ReactNode }) {
  const { data } = useApi<Harness[]>("/harnesses");

  return <Catalog.Provider value={data ?? []}>{children}</Catalog.Provider>;
}

export function modelDisplayName(model: string): string {
  return (model.split("/").at(-1) ?? model)
    .split("-")
    .map((part) =>
      /^(gpt|glm|llama)$/i.test(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/^GPT /, "GPT-");
}

export function HarnessIcon({ harness }: { harness: string }) {
  const brand = brands[harness];

  return (
    <Tooltip text={brand?.title ?? harness}>
      <span className={`harness-icon harness-${harness}`}>
        <span aria-hidden="true">{brand?.fallback ?? harness.slice(0, 1)}</span>
        {brand && (
          <img
            src={brand.icon}
            alt={brand.title}
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </span>
    </Tooltip>
  );
}

export function useModelName() {
  const catalog = useContext(Catalog);
  return (harness: string, model: string) =>
    catalog
      .find((item) => item.id === harness)
      ?.models.find((item) => item.id === model)?.name ??
    modelDisplayName(model);
}
export function ModelReference({
  harness,
  model,
}: {
  harness: string;
  model: string;
}) {
  const name = useModelName()(harness, model);
  return (
    <span className="model-reference">
      <HarnessIcon harness={harness} />
      <Tooltip text={model}>
        <span>{name}</span>
      </Tooltip>
    </span>
  );
}

export function ModelKey({ value }: { value: string }) {
  const separator = value.indexOf("/");

  return (
    <ModelReference
      harness={value.slice(0, separator).trim()}
      model={value.slice(separator + 1).trim()}
    />
  );
}
