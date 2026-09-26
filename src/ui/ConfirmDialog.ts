import { type App, Modal, Setting } from 'obsidian';

export interface ConfirmDialogOptions {
  title: string;
  /** One paragraph per entry, rendered in order. */
  lines: string[];
  confirmText?: string;
  cancelText?: string;
}

/**
 * A yes/no confirmation with a title and one or more text lines (011, "zwei
 * Bestätigungen (Vorschau, LLM-Verweis)"): "Übernehmen" resolves to `true`,
 * every other way of closing it — "Abbrechen", Escape, the close cross, a
 * click outside — resolves to `false` (pattern of {@link AdoptDialog}/
 * {@link ProjectDialog}, S79). No file is ever touched by the dialog itself.
 */
export class ConfirmDialog extends Modal {
  private result = false;
  private resolveFn: (value: boolean) => void = () => {};

  private constructor(
    app: App,
    private readonly options: ConfirmDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: ConfirmDialogOptions): Promise<boolean> {
    const dialog = new ConfirmDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    for (const line of this.options.lines) {
      this.contentEl.createEl('p', { text: line });
    }
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(this.options.cancelText ?? 'Abbrechen').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(this.options.confirmText ?? 'Übernehmen')
          .onClick(() => {
            this.result = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.result);
  }
}
