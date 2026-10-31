import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { FastModeController } from "./fast.ts";
import type { PauseController } from "./pause.ts";

const PATCH = Symbol.for("cliproxyapi-provider/fast-footer");
const REFRESH_KEY = "cliproxyapi-fast-refresh";
const ORANGE_TRUECOLOR = "\u001B[38;2;255;165;0m";
const ORANGE_256 = "\u001B[38;5;214m";
const FG_RESET = "\u001B[39m";

/** The part of pi's private footer session this patch reads. Checked on every render, because pi may change it. */
const FooterSessionSchema = Type.Object({
  state: Type.Object({
    model: Type.Optional(
      Type.Object({
        id: Type.String(),
        provider: Type.String(),
        reasoning: Type.Boolean(),
      })
    ),
    thinkingLevel: Type.Optional(Type.String()),
  }),
});

type MutableModel = NonNullable<
  Static<typeof FooterSessionSchema>["state"]["model"]
>;

interface PatchState {
  controllers: Set<FastFooterController>;
  original: FooterComponent["render"];
  patched: FooterComponent["render"];
}

type PatchableFooter = FooterComponent & { [PATCH]?: PatchState };

export const formatFastModelStatus = (
  modelName: string,
  reasoning: boolean,
  thinkingLevel: string,
  fast: boolean,
  fastLabel = "fast",
  paused = false,
  pausedLabel = "paused"
): string => {
  let status = modelName;

  if (reasoning) {
    status +=
      thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
  }

  if (fast) {
    status += ` • ${fastLabel}`;
  }

  if (paused) {
    status += ` • ${pausedLabel}`;
  }

  return status;
};

const install = (controller: FastFooterController): void => {
  // SAFETY: FooterComponent is the runtime class whose prototype carries this extension's symbol-owned patch metadata.
  const prototype = FooterComponent.prototype as PatchableFooter;
  let state = prototype[PATCH];

  if (!state) {
    const original = prototype.render;
    state = {
      controllers: new Set(),
      original,
      patched(this: FooterComponent, width: number): string[] {
        const session: unknown = this["session"];

        if (!Value.Check(FooterSessionSchema, session)) {
          return original.call(this, width);
        }

        const { model } = session.state;

        const active = model
          ? [...(state?.controllers ?? [])].find((candidate) =>
              candidate.isProviderModel(model)
            )
          : undefined;

        if (!model || !active) {
          return original.call(this, width);
        }

        const { id } = model;
        const { reasoning } = model;
        const fast = active.isEffectiveFor(model);

        if (fast || active.isPaused()) {
          model.id = active.formatModelStatus(
            id,
            reasoning,
            session.state.thinkingLevel ?? "off",
            fast
          );
          model.reasoning = false;
        }

        try {
          return original.call(this, width);
        } finally {
          model.id = id;
          model.reasoning = reasoning;
        }
      },
    };
    prototype[PATCH] = state;
    prototype.render = state.patched;
  }

  state.controllers.add(controller);
};

const uninstall = (controller: FastFooterController): void => {
  // SAFETY: This is the same symbol-owned footer prototype augmented by install().
  const prototype = FooterComponent.prototype as PatchableFooter;
  const state = prototype[PATCH];
  state?.controllers.delete(controller);

  if (!state || state.controllers.size > 0) {
    return;
  }

  if (prototype.render === state.patched) {
    prototype.render = state.original;
  }

  Reflect.deleteProperty(prototype, PATCH);
};

export class FastFooterController {
  private activeContext: ExtensionContext | undefined;
  private installed = false;
  private readonly providerId: string;
  private readonly fast: FastModeController;
  private readonly pause: PauseController;

  constructor(
    providerId: string,
    fast: FastModeController,
    pause: PauseController
  ) {
    this.providerId = providerId;
    this.fast = fast;
    this.pause = pause;
  }

  register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      this.activeContext = ctx;

      if (!this.installed) {
        install(this);
        this.installed = true;
      }
    });
    pi.on("session_shutdown", () => {
      this.activeContext = undefined;

      if (this.installed) {
        uninstall(this);
        this.installed = false;
      }
    });
  }

  isProviderModel(model: MutableModel): boolean {
    return model.provider === this.providerId;
  }

  isEffectiveFor(model: MutableModel): boolean {
    return this.isProviderModel(model) && this.fast.isEffectiveFor(model.id);
  }

  isPaused(): boolean {
    return this.pause.isEnabled();
  }

  formatModelStatus(
    modelName: string,
    reasoning: boolean,
    thinkingLevel: string,
    fast: boolean
  ): string {
    const theme = this.activeContext?.ui.theme;

    const color =
      theme?.getColorMode?.() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;

    const pausedLabel = theme ? `${color}paused${FG_RESET}` : "paused";

    return formatFastModelStatus(
      modelName,
      reasoning,
      thinkingLevel,
      fast,
      theme?.fg("warning", "fast") ?? "fast",
      this.pause.isEnabled(),
      pausedLabel
    );
  }

  refresh(ctx: ExtensionContext): void {
    if (ctx.mode === "tui") {
      this.activeContext = ctx;
      ctx.ui.setStatus(REFRESH_KEY, undefined);
    }
  }
}
