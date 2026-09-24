import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';
import type { Column } from '../core/settings';
import { isValidColumnKey } from '../core/settings';

export interface ColumnDialogTargetOptions {
  kind: 'target';
  /** The columns the members may move to (every column but the one removed). */
  targets: Column[];
}

export interface ColumnDialogKeyOptions {
  kind: 'key';
  /** A free slug offered as the starting value of the key field. */
  suggestion: string;
  /** The other columns, to keep the typed key unique (006 addendum 2026-09-22). */
  existing: Column[];
}

export interface ColumnDialogConfirmOptions {
  kind: 'confirm';
  /** The end role of the column being removed (S46). */
  role: 'done' | 'wont-do';
}

export type ColumnDialogOptions = ColumnDialogTargetOptions | ColumnDialogKeyOptions | ColumnDialogConfirmOptions;

/**
 * Asks for the one thing a column removal or role change still needs before
 * its members can move (F070 S38/S39, F080 S46, DESIGN.md's plain Obsidian
 * Modal, no own styling): a target column (dropdown), a fresh key for the
 * column itself (text field, confirm locked while the key fails
 * {@link isValidColumnKey}), or a plain confirmation before an end column
 * with members disappears. Resolves to the chosen value (or a fixed marker
 * for `confirm`), or `null` on Abbrechen, Escape or any other way of closing
 * the modal — a plain `Modal.close()` always runs `onClose`, so every path
 * resolves exactly once.
 */
export class ColumnDialog extends Modal {
  private result: string | null = null;
  private resolveFn: (value: string | null) => void = () => {};

  private constructor(
    app: App,
    private readonly count: number,
    private readonly columnName: string,
    private readonly options: ColumnDialogOptions,
  ) {
    super(app);
  }

  static ask(
    app: App,
    count: number,
    columnName: string,
    options: ColumnDialogOptions,
  ): Promise<string | null> {
    const dialog = new ColumnDialog(app, count, columnName, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    const noun = this.count === 1 ? 'Aufgabe' : 'Aufgaben';

    if (this.options.kind === 'confirm') {
      this.setTitle('Spalte entfernen');
      const roleWord = this.options.role === 'done' ? 'erledigt' : 'verworfen';
      this.contentEl.createEl('p', {
        text: `${this.count} ${noun} in „${this.columnName}“ bleiben ${roleWord} und liegen weiterhin unter Done/.`,
      });
      this.contentEl.createEl('p', {
        text: `Ohne diese Spalte erscheinen sie nicht auf dem Board. Sie kommen zurück, sobald wieder eine Spalte mit der Rolle ${roleWord} angelegt wird.`,
      });
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
        .addButton((button) =>
          button
            .setWarning()
            .setButtonText('Entfernen')
            .onClick(() => {
              this.result = 'remove';
              this.close();
            }),
        );
      return;
    }

    this.setTitle(this.options.kind === 'target' ? 'Zielspalte wählen' : 'Neuer Schlüssel');
    this.contentEl.createEl('p', { text: `${this.count} ${noun} in „${this.columnName}“` });

    let value = '';
    let confirmButton: ButtonComponent | undefined;

    if (this.options.kind === 'target') {
      value = this.options.targets[0]?.status ?? '';
      new Setting(this.contentEl).addDropdown((dropdown) => {
        for (const column of this.options.kind === 'target' ? this.options.targets : []) {
          dropdown.addOption(column.status, column.name);
        }
        dropdown.setValue(value);
        dropdown.onChange((next) => {
          value = next;
        });
      });
    } else {
      value = this.options.suggestion;
      new Setting(this.contentEl).addText((text) => {
        text.inputEl.addClass('ktm-textinput', 'is-mono');
        text.setValue(value).onChange((next) => {
          value = next.trim();
          const existing = this.options.kind === 'key' ? this.options.existing : [];
          confirmButton?.setDisabled(!isValidColumnKey(value, existing));
        });
      });
    }

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) => {
        confirmButton = button;
        button
          .setCta()
          .setButtonText('Übernehmen')
          .onClick(() => {
            this.result = value;
            this.close();
          });
        if (this.options.kind === 'key') {
          button.setDisabled(!isValidColumnKey(value, this.options.existing));
        }
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.result);
  }
}
