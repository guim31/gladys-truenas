// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, state words (features, scene variables, widget
// rows), the command answers and the "Test the connection" report. Four
// languages, the four of the Gladys interface; German says "du", Spanish
// "usted". test/i18n.test.js checks every table. (Adapted from
// guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './truenas/client.js';

export const LANGUAGE_FALLBACK = 'en';

/** The text of a multi-language object in a language, English otherwise. */
export const pick = (value, language) =>
  value?.[language] ?? value?.[LANGUAGE_FALLBACK] ?? Object.values(value ?? {})[0] ?? '';

/** "Name: detail", with the French space before the colon. */
export const labelled = (name, detail, language) =>
  language === 'fr' ? `${name} : ${detail}` : `${name}: ${detail}`;

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  notConfigured: {
    en: 'Enter the address of the NAS and an API key in the configuration.',
    fr: "Saisissez l'adresse du NAS et une clé d'API dans la configuration.",
    de: 'Gib die Adresse des NAS und einen API-Schlüssel in der Konfiguration ein.',
    es: 'Introduzca la dirección del NAS y una clave de API en la configuración.',
  },
  invalidAddress: {
    en: 'Address not understood, e.g. 192.168.1.20 or https://truenas.local',
    fr: 'Adresse incomprise, ex. 192.168.1.20 ou https://truenas.local',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.20 oder https://truenas.local',
    es: 'Dirección no válida, p. ej. 192.168.1.20 o https://truenas.local',
  },
  insecureAddress: {
    en: 'HTTPS only: TrueNAS revokes an API key sent over HTTP. Remove "http://" from the address.',
    fr: "HTTPS seulement : TrueNAS révoque une clé d'API envoyée en HTTP. Retirez « http:// » de l'adresse.",
    de: 'Nur HTTPS: TrueNAS widerruft einen über HTTP gesendeten API-Schlüssel. Entferne „http://“ aus der Adresse.',
    es: 'Solo HTTPS: TrueNAS revoca una clave de API enviada por HTTP. Quite «http://» de la dirección.',
  },
};

// One short explanation per error kind (src/truenas/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer (is it on, is the address right?)',
    fr: "ne répond pas (est-il allumé, l'adresse est-elle juste ?)",
    de: 'antwortet nicht (ist es an, stimmt die Adresse?)',
    es: 'no responde (¿está encendido, es correcta la dirección?)',
  },
  [ERROR_KINDS.CERTIFICATE]: {
    en: 'HTTPS certificate refused: tick "Accept a self-signed certificate"',
    fr: 'certificat HTTPS refusé : cochez « Accepter un certificat auto-signé »',
    de: 'HTTPS-Zertifikat abgelehnt: Aktiviere „Selbstsigniertes Zertifikat akzeptieren“',
    es: 'certificado HTTPS rechazado: marque «Aceptar un certificado autofirmado»',
  },
  [ERROR_KINDS.NOT_TRUENAS]: {
    en: 'no TrueNAS 25.04+ API at this address (HTTPS port?)',
    fr: "pas d'API TrueNAS 25.04+ à cette adresse (port HTTPS ?)",
    de: 'keine TrueNAS-API ab 25.04 unter dieser Adresse (HTTPS-Port?)',
    es: 'no hay API de TrueNAS 25.04+ en esta dirección (¿puerto HTTPS?)',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API key refused (wrong, expired or revoked); create a new one, then save',
    fr: "clé d'API refusée (fausse, expirée ou révoquée) ; créez-en une autre puis enregistrez",
    de: 'API-Schlüssel abgelehnt (falsch, abgelaufen oder widerrufen); erstelle einen neuen und speichere',
    es: 'clave de API rechazada (incorrecta, caducada o revocada); cree otra y guarde',
  },
  [ERROR_KINDS.PERMISSION]: {
    en: 'the user of the API key lacks a right (Read-only Administrator at least)',
    fr: "l'utilisateur de la clé d'API n'a pas un droit (Administrateur en lecture seule au moins)",
    de: 'dem Benutzer des API-Schlüssels fehlt ein Recht (mindestens Read-only Administrator)',
    es: 'al usuario de la clave de API le falta un permiso (Administrador de solo lectura al menos)',
  },
  [ERROR_KINDS.PROTOCOL]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The state of a pool (src/truenas/model.js POOL_STATES), in words.
export const POOL_STATE_TEXT = {
  online: { en: 'Online', fr: 'En ligne', de: 'Online', es: 'En línea' },
  errors: { en: 'Errors', fr: 'Erreurs', de: 'Fehler', es: 'Errores' },
  degraded: { en: 'Degraded', fr: 'Dégradé', de: 'Beeinträchtigt', es: 'Degradado' },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
  offline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Fuera de línea' },
  faulted: { en: 'Faulted', fr: 'En panne', de: 'Ausgefallen', es: 'Averiado' },
  unavail: { en: 'Unavailable', fr: 'Indisponible', de: 'Nicht verfügbar', es: 'No disponible' },
  removed: { en: 'Removed', fr: 'Retiré', de: 'Entfernt', es: 'Retirado' },
  suspended: { en: 'Suspended', fr: 'Suspendu', de: 'Angehalten', es: 'Suspendido' },
};

// The SMART summary of a disk (src/truenas/model.js DISK_STATES), in words.
export const DISK_STATE_TEXT = {
  ok: {
    en: 'No SMART alert',
    fr: 'Aucune alerte SMART',
    de: 'Keine SMART-Warnung',
    es: 'Sin alerta SMART',
  },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
  warning: { en: 'SMART warning', fr: 'Alerte SMART', de: 'SMART-Warnung', es: 'Aviso SMART' },
  failed: {
    en: 'SMART test failed',
    fr: 'Test SMART échoué',
    de: 'SMART-Test gescheitert',
    es: 'Prueba SMART fallida',
  },
};

// The state of an app or a virtual machine (src/truenas/model.js RUN_STATES).
export const RUN_STATE_TEXT = {
  running: { en: 'Running', fr: 'En marche', de: 'Läuft', es: 'En marcha' },
  stopped: { en: 'Stopped', fr: 'Arrêté', de: 'Gestoppt', es: 'Detenido' },
  deploying: { en: 'Deploying', fr: 'Déploiement', de: 'Wird bereitgestellt', es: 'Desplegando' },
  starting: { en: 'Starting', fr: 'Démarrage', de: 'Startet', es: 'Iniciando' },
  stopping: { en: 'Stopping', fr: 'Arrêt en cours', de: 'Wird gestoppt', es: 'Deteniéndose' },
  crashed: { en: 'Crashed', fr: 'Planté', de: 'Abgestürzt', es: 'Fallido' },
  suspended: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
};

// The level of a TrueNAS alert (src/truenas/model.js ALERT_LEVELS), and `none`.
export const ALERT_LEVEL_TEXT = {
  none: { en: 'None', fr: 'Aucune', de: 'Keine', es: 'Ninguna' },
  info: { en: 'Info', fr: 'Info', de: 'Info', es: 'Info' },
  notice: { en: 'Notice', fr: 'Notification', de: 'Hinweis', es: 'Aviso' },
  warning: { en: 'Warning', fr: 'Avertissement', de: 'Warnung', es: 'Advertencia' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  critical: { en: 'Critical', fr: 'Critique', de: 'Kritisch', es: 'Crítica' },
  alert: { en: 'Alert', fr: 'Alerte', de: 'Alarm', es: 'Alerta' },
  emergency: { en: 'Emergency', fr: 'Urgence', de: 'Notfall', es: 'Emergencia' },
};

// The commands: start and stop (feature switches), restart and shut down
// (scene actions).
export const COMMAND_TEXT = {
  appControlDisabled: {
    en: 'Starting and stopping apps and VMs is disabled in the configuration of the integration.',
    fr: "Le démarrage et l'arrêt des applications et VM sont désactivés dans la configuration de l'intégration.",
    de: 'Starten und Stoppen von Apps und VMs sind in der Konfiguration der Integration deaktiviert.',
    es: 'El inicio y la parada de aplicaciones y VM están desactivados en la configuración de la integración.',
  },
  powerDisabled: {
    en: 'Restarting and shutting down the NAS are disabled in the configuration of the integration.',
    fr: "Le redémarrage et l'arrêt du NAS sont désactivés dans la configuration de l'intégration.",
    de: 'Neustart und Herunterfahren des NAS sind in der Konfiguration der Integration deaktiviert.',
    es: 'El reinicio y el apagado del NAS están desactivados en la configuración de la integración.',
  },
  notConnected: {
    en: 'The NAS is not connected: nothing was sent.',
    fr: "Le NAS n'est pas connecté : rien n'a été envoyé.",
    de: 'Das NAS ist nicht verbunden: Nichts wurde gesendet.',
    es: 'El NAS no está conectado: no se ha enviado nada.',
  },
  unknownTarget: {
    en: 'This app or VM is no longer on the NAS.',
    fr: "Cette application ou VM n'est plus sur le NAS.",
    de: 'Diese App oder VM ist nicht mehr auf dem NAS.',
    es: 'Esta aplicación o VM ya no está en el NAS.',
  },
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'connected',
    pools: (count) => `${count} pool(s)`,
    disks: (count) => `${count} disk(s)`,
    apps: (count) => `${count} app(s)`,
    vms: (count) => `${count} VM(s)`,
    alerts: (count) => `${count} active alert(s)`,
    partial: 'some parts refused, see the logs',
  },
  fr: {
    ok: 'connecté',
    pools: (count) => `${count} pool(s)`,
    disks: (count) => `${count} disque(s)`,
    apps: (count) => `${count} application(s)`,
    vms: (count) => `${count} VM`,
    alerts: (count) => `${count} alerte(s) active(s)`,
    partial: 'certaines parties refusées, voir les logs',
  },
  de: {
    ok: 'verbunden',
    pools: (count) => `${count} Pool(s)`,
    disks: (count) => `${count} Festplatte(n)`,
    apps: (count) => `${count} App(s)`,
    vms: (count) => `${count} VM(s)`,
    alerts: (count) => `${count} aktive Warnung(en)`,
    partial: 'einige Teile verweigert, sieh in den Protokollen nach',
  },
  es: {
    ok: 'conectado',
    pools: (count) => `${count} pool(s)`,
    disks: (count) => `${count} disco(s)`,
    apps: (count) => `${count} aplicación(es)`,
    vms: (count) => `${count} VM`,
    alerts: (count) => `${count} alerta(s) activa(s)`,
    partial: 'algunas partes rechazadas, consulte los registros',
  },
};

// Short units, for the widget rows.
export const UNIT_TEXT = {
  gigabyte: { en: 'GB', fr: 'Go', de: 'GB', es: 'GB' },
  terabyte: { en: 'TB', fr: 'To', de: 'TB', es: 'TB' },
  day: { en: 'd', fr: 'j', de: 'T', es: 'd' },
  hour: { en: 'h', fr: 'h', de: 'Std.', es: 'h' },
};

const LOCALES = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

export const formatNumber = (value, language, digits = 1) =>
  new Intl.NumberFormat(LOCALES[language] ?? LOCALES.en, {
    maximumFractionDigits: digits,
  }).format(value);

export const formatPercent = (value, language) => `${formatNumber(value, language, 0)} %`;

/** Bytes as GB, or TB from 1000 GB on (decimal units, as TrueNAS shows them). */
export function formatSize(bytes, language) {
  const gigabytes = bytes / 1e9;
  if (gigabytes >= 1000) {
    return `${formatNumber(gigabytes / 1000, language, 1)} ${pick(UNIT_TEXT.terabyte, language)}`;
  }
  return `${formatNumber(gigabytes, language, gigabytes < 10 ? 1 : 0)} ${pick(UNIT_TEXT.gigabyte, language)}`;
}

/** Seconds as "12 d 4 h". */
export function formatUptime(seconds, language) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const day = pick(UNIT_TEXT.day, language);
  const hour = pick(UNIT_TEXT.hour, language);
  return days > 0 ? `${days} ${day} ${hours} ${hour}` : `${hours} ${hour}`;
}
