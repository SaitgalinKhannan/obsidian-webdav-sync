import { App, Notice, PluginSettingTab, Setting, TextAreaComponent } from "obsidian";
import type WebDavSyncPlugin from "./main";
import {
	decodeSetupCode,
	encodeSetupCodeEncrypted,
	encodeSetupCodePlain,
} from "./setupcode";

/**
 * Settings screen. The flow mirrors how the user wants to work:
 *   • On the PC: fill host / user / password, press "Connect & set up" — done.
 *   • On phones: paste one setup code from the PC and press "Connect this device".
 */
export class WebDavSettingTab extends PluginSettingTab {
	private codeArea: TextAreaComponent | null = null;

	constructor(app: App, private readonly plugin: WebDavSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --- Connection ------------------------------------------------------------------
		containerEl.createEl("h2", { text: "Подключение к серверу" });
		containerEl.createEl("p", {
			text: "Данные твоего VPS: адрес, пользователь и пароль WebDAV.",
			cls: "wds-section-note",
		});

		new Setting(containerEl)
			.setName("Адрес (IP или домен)")
			.setDesc("Без http:// — например 203.0.113.10 или vault.example.com")
			.addText((t) =>
				t
					.setPlaceholder("vault.example.com")
					.setValue(s.host)
					.onChange(async (v) => {
						s.host = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Порт")
			.addText((t) =>
				t
					.setPlaceholder("443")
					.setValue(String(s.port))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						if (!Number.isNaN(n) && n > 0) {
							s.port = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("HTTPS")
			.setDesc("Обязательно для iOS. Выключай только для теста по локальной сети.")
			.addToggle((t) =>
				t.setValue(s.useHttps).onChange(async (v) => {
					s.useHttps = v;
					if (v && s.port === 80) s.port = 443;
					if (!v && s.port === 443) s.port = 80;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		new Setting(containerEl).setName("Пользователь").addText((t) =>
			t.setValue(s.username).onChange(async (v) => {
				s.username = v.trim();
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Пароль").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(s.password).onChange(async (v) => {
				s.password = v;
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("Папка на сервере")
			.setDesc("Куда складывать это хранилище. Заполняется автоматически.")
			.addText((t) =>
				t
					.setPlaceholder("/obsidian/MyVault")
					.setValue(s.remoteBaseDir)
					.onChange(async (v) => {
						s.remoteBaseDir = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Имя устройства")
			.setDesc("Показывается в именах конфликтных копий.")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim() || s.deviceName;
					await this.plugin.saveSettings();
				}),
			);

		// --- Primary setup (PC) ----------------------------------------------------------
		containerEl.createEl("h2", { text: "Первичная настройка (на ПК)" });
		new Setting(containerEl)
			.setName("Проверить подключение")
			.addButton((b) =>
				b.setButtonText("Проверить").onClick(async () => {
					b.setDisabled(true);
					const res = await this.plugin.testConnection();
					new Notice(`WebDAV Sync: ${res.message}`);
					b.setDisabled(false);
				}),
			);

		new Setting(containerEl)
			.setName("Подключиться и настроить")
			.setDesc("Создаёт папку на сервере и делает первую полную синхронизацию.")
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Подключиться и настроить")
					.onClick(async () => {
						b.setDisabled(true);
						const ok = await this.plugin.runInitialSetup();
						if (ok) new Notice("WebDAV Sync: настройка завершена ✔");
						b.setDisabled(false);
						this.display();
					}),
			);

		// --- Connect a phone -------------------------------------------------------------
		containerEl.createEl("h2", { text: "Подключить телефон / другое устройство" });

		if (s.configured) {
			containerEl.createEl("p", {
				text:
					"Создай код на этом ПК и вставь его на телефоне. Код содержит пароль — " +
					"лучше задать секретную фразу, тогда он будет зашифрован.",
				cls: "wds-section-note",
			});

			let passphrase = "";
			new Setting(containerEl)
				.setName("Секретная фраза для кода (необязательно)")
				.setDesc("Если задать — код зашифруется; ту же фразу введёшь на телефоне.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.onChange((v) => (passphrase = v));
				});

			new Setting(containerEl).setName("Код для подключения").addButton((b) =>
				b.setButtonText("Создать код").onClick(async () => {
					const cfg = this.plugin.currentConnection();
					const code = passphrase
						? await encodeSetupCodeEncrypted(cfg, passphrase)
						: encodeSetupCodePlain(cfg);
					this.codeArea?.setValue(code);
					try {
						await navigator.clipboard.writeText(code);
						new Notice("Код создан и скопирован в буфер обмена.");
					} catch {
						new Notice("Код создан — выдели и скопируй его вручную.");
					}
				}),
			);

			new Setting(containerEl).setName("").then((setting) => {
				setting.settingEl.addClass("wds-code-row");
				const ta = new TextAreaComponent(setting.controlEl);
				ta.inputEl.addClass("wds-setup-code");
				ta.inputEl.readOnly = true;
				ta.setPlaceholder("Здесь появится код WDS…");
				this.codeArea = ta;
			});
		} else {
			containerEl.createEl("p", {
				text: "Сначала выполни первичную настройку выше, тогда появится кнопка создания кода.",
				cls: "wds-section-note",
			});
		}

		// Paste a code from another device.
		let pasteCode = "";
		let pastePass = "";
		new Setting(containerEl)
			.setName("Вставить код с ПК")
			.setDesc("Подключает это устройство к тому же серверу и хранилищу.")
			.addTextArea((t) => {
				t.inputEl.addClass("wds-setup-code");
				t.setPlaceholder("Вставь сюда код WDS1:… или WDSX:…");
				t.onChange((v) => (pasteCode = v));
			});

		new Setting(containerEl)
			.setName("Секретная фраза (если код зашифрован)")
			.addText((t) => {
				t.inputEl.type = "password";
				t.onChange((v) => (pastePass = v));
			});

		new Setting(containerEl).setName("Подключить это устройство").addButton((b) =>
			b
				.setCta()
				.setButtonText("Подключить это устройство")
				.onClick(async () => {
					if (!pasteCode.trim()) {
						new Notice("Вставь код из ПК.");
						return;
					}
					b.setDisabled(true);
					try {
						const cfg = await decodeSetupCode(pasteCode, pastePass || undefined);
						const ok = await this.plugin.applyConnection(cfg);
						if (ok) new Notice("Устройство подключено и синхронизировано ✔");
						this.display();
					} catch (e) {
						new Notice(`Не получилось: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						b.setDisabled(false);
					}
				}),
		);

		// --- Sync options ----------------------------------------------------------------
		containerEl.createEl("h2", { text: "Синхронизация" });

		new Setting(containerEl)
			.setName("Интервал автосинхронизации (минуты)")
			.setDesc("0 — выключить автосинхронизацию по таймеру.")
			.addText((t) =>
				t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) {
						s.syncIntervalMinutes = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Синхронизировать при запуске")
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Синхронизировать после изменений")
			.setDesc("Через несколько секунд после того, как ты перестал печатать.")
			.addToggle((t) =>
				t.setValue(s.syncOnFileChange).onChange(async (v) => {
					s.syncOnFileChange = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
