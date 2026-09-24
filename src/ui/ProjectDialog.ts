import { type App, Modal, Setting, type TextComponent } from 'obsidian';
import { columnKey, type ProjectSettings, validateNewProject } from '../core/settings';

export interface ProjectDialogCreateOptions {
  kind: 'create';
  /** Every known project, hidden ones included (validateNewProject's overlap check). */
  existing: ProjectSettings[];
}

export interface ProjectDialogCreateResult {
  name: string;
  key: string;
  root: string;
}

export interface ProjectDialogRemoveOptions {
  kind: 'remove';
  count: number;
  name: string;
}

export type ProjectDialogOptions = ProjectDialogCreateOptions | ProjectDialogRemoveOptions;
export type ProjectDialogResult = ProjectDialogCreateResult | 'remove' | null;

const DEFAULT_ROOT_PREFIX = '02_Projects/';
const DEFAULT_ROOT_SUFFIX = '/Deliverables';

/**
 * Asks for what "Projekt hinzufügen" or a project's Kreuz still needs (006
 * addendum 2026-09-24, S47/S48/S52): either the three fields of a new project
 * — Kürzel and Root follow the typed name via {@link columnKey} until edited
 * by hand, `validateNewProject` runs only on confirm and keeps the dialog open
 * with its reason instead of closing (K6-K8) — or a plain confirmation before
 * a project with tasks disappears. Resolves to the new project's fields, the
 * marker `'remove'`, or `null` on Abbrechen, Escape or any other way of
 * closing the modal (pattern of {@link ColumnDialog}).
 */
export class ProjectDialog extends Modal {
  private result: ProjectDialogResult = null;
  private resolveFn: (value: ProjectDialogResult) => void = () => {};

  private constructor(
    app: App,
    private readonly options: ProjectDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: ProjectDialogOptions): Promise<ProjectDialogResult> {
    const dialog = new ProjectDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    if (this.options.kind === 'remove') {
      this.renderRemove(this.options);
      return;
    }
    this.renderCreate(this.options);
  }

  private renderRemove(options: ProjectDialogRemoveOptions): void {
    const noun = options.count === 1 ? 'Aufgabe' : 'Aufgaben';
    this.setTitle('Projekt entfernen');
    this.contentEl.createEl('p', {
      text: `${options.count} ${noun} in „${options.name}“ bleiben liegen, erscheinen aber nicht mehr auf dem Board.`,
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
  }

  private renderCreate(options: ProjectDialogCreateOptions): void {
    this.setTitle('Projekt hinzufügen');

    let name = '';
    let key = '';
    let root = '';
    let keyTouched = false;
    let rootTouched = false;
    let keyInput: TextComponent | undefined;
    let rootInput: TextComponent | undefined;

    const errorEl = this.contentEl.createEl('p', { cls: 'ktm-dialog-error' });

    new Setting(this.contentEl).setName('Name').addText((text) => {
      text.inputEl.setAttribute('data-field', 'name');
      text.onChange((value) => {
        name = value;
        if (!keyTouched) {
          key = columnKey(value);
          keyInput?.setValue(key);
        }
        if (!rootTouched) {
          root = value.trim() ? `${DEFAULT_ROOT_PREFIX}${value.trim()}${DEFAULT_ROOT_SUFFIX}` : '';
          rootInput?.setValue(root);
        }
      });
    });

    new Setting(this.contentEl).setName('Kürzel').addText((text) => {
      keyInput = text;
      text.inputEl.addClass('ktm-textinput', 'is-mono');
      text.inputEl.setAttribute('data-field', 'key');
      text.onChange((value) => {
        keyTouched = true;
        key = value.trim();
      });
    });

    new Setting(this.contentEl).setName('Root').addText((text) => {
      rootInput = text;
      text.inputEl.setAttribute('data-field', 'root');
      text.onChange((value) => {
        rootTouched = true;
        root = value.trim();
      });
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText('Anlegen')
          .onClick(() => {
            const reason = validateNewProject(name, key, root, options.existing);
            if (reason) {
              errorEl.setText(reason);
              return;
            }
            this.result = { name: name.trim(), key, root: root.replace(/\/+$/, '') };
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.result);
  }
}
