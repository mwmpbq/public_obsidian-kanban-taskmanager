import { type App, Modal, Notice, Setting } from 'obsidian';

export interface ViewNameDialogOptions {
  title: string;
  initialName?: string;
  /** Hinweistext für einen ungültigen Namen, sonst undefined (001, Ergänzung 2026-10-18). */
  validate: (name: string) => string | undefined;
}

/**
 * Freies Namensfeld für "Als Ansicht speichern …" (001, Ergänzung
 * 2026-10-18): "Speichern" (oder Enter im Feld) löst mit dem getrimmten
 * Namen auf, sobald `validate` ihn akzeptiert; ein ungültiger Name zeigt ein
 * Notice und lässt den Dialog offen (K7). Escape, das Kreuz, ein Klick
 * daneben und "Abbrechen" lösen mit undefined auf, ohne zu prüfen (Muster
 * von {@link ConfirmDialog}).
 */
export class ViewNameDialog extends Modal {
  private result: string | undefined;
  private submitted = false;
  private resolveFn: (value: string | undefined) => void = () => {};

  private constructor(
    app: App,
    private readonly options: ViewNameDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: ViewNameDialogOptions): Promise<string | undefined> {
    const dialog = new ViewNameDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass('ktm-viewname-modal');
    this.setTitle(this.options.title);

    let inputEl: HTMLInputElement | undefined;
    new Setting(this.contentEl).addText((text) => {
      text.inputEl.addClass('ktm-viewname-input');
      text.setValue(this.options.initialName ?? '');
      inputEl = text.inputEl;
      text.inputEl.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        this.submit(text.getValue());
      });
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText('Speichern')
          .onClick(() => this.submit(inputEl?.value ?? '')),
      );

    window.setTimeout(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  private submit(name: string): void {
    const error = this.options.validate(name);
    if (error) {
      new Notice(error);
      return;
    }
    this.result = name.trim();
    this.submitted = true;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.submitted ? this.result : undefined);
  }
}
