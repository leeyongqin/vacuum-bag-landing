/**
 * Confirmation email templates (6 languages).
 *
 * The landing page promises an immediate confirmation ("Sie erhalten sofort
 * eine Bestätigung"), so `handleSubmit` in src/worker.js sends one after a
 * successful registration. Wording here mirrors the `L` dictionary in
 * public/index.html so the page and the inbox never contradict each other.
 *
 * Delivery is provider-agnostic: see `sendConfirmationEmail` in worker.js.
 * Templates are intentionally inline-styled (email clients ignore <style>).
 */

const TEMPLATES = {
  de: {
    subject: (b) => `Ihre 12-Monats-Garantie ist aktiviert – ${b}`,
    heading: 'Garantie aktiviert!',
    intro: 'Vielen Dank für Ihren Kauf. Ihre 12 Monate kostenlose Garantieverlängerung ist ab sofort aktiv.',
    orderLabel: 'Bestellnummer (letzte 4 Ziffern)',
    keep: 'Bewahren Sie diese E-Mail als Nachweis für Ihre Garantie auf.',
    help: 'Fragen zu Kompatibilität oder einem Defekt? Antworten Sie einfach auf diese E-Mail.',
    footer: 'Diese E-Mail wurde im Rahmen Ihrer Garantieregistrierung gesendet. Diese Website steht in keiner Verbindung mit Amazon.com, Inc. oder seinen Tochtergesellschaften.',
  },
  fr: {
    subject: (b) => `Votre garantie de 12 mois est activée – ${b}`,
    heading: 'Garantie activée !',
    intro: 'Merci pour votre achat. Votre extension de garantie de 12 mois est active dès maintenant.',
    orderLabel: 'Numéro de commande (4 derniers chiffres)',
    keep: 'Conservez cet e-mail comme preuve de votre garantie.',
    help: 'Une question sur la compatibilité ou un défaut ? Répondez simplement à cet e-mail.',
    footer: 'Cet e-mail a été envoyé dans le cadre de votre enregistrement de garantie. Ce site n\'est pas affilié à Amazon.com, Inc. ou à ses filiales.',
  },
  it: {
    subject: (b) => `La tua garanzia di 12 mesi è attivata – ${b}`,
    heading: 'Garanzia attivata!',
    intro: 'Grazie per il tuo acquisto. La tua estensione di garanzia di 12 mesi è attiva fin da subito.',
    orderLabel: 'Numero d\'ordine (ultime 4 cifre)',
    keep: 'Conserva questa e-mail come prova della tua garanzia.',
    help: 'Domande su compatibilità o difetti? Rispondi semplicemente a questa e-mail.',
    footer: 'Questa e-mail è stata inviata nell\'ambito della registrazione della garanzia. Questo sito non è affiliato ad Amazon.com, Inc. o alle sue filiali.',
  },
  es: {
    subject: (b) => `Tu garantía de 12 meses está activada – ${b}`,
    heading: '¡Garantía activada!',
    intro: 'Gracias por tu compra. Tu extensión de garantía de 12 meses está activa desde ya.',
    orderLabel: 'Número de pedido (últimos 4 dígitos)',
    keep: 'Guarda este correo como comprobante de tu garantía.',
    help: '¿Dudas sobre compatibilidad o algún defecto? Responde simplemente a este correo.',
    footer: 'Este correo se envió como parte del registro de tu garantía. Este sitio no está afiliado a Amazon.com, Inc. ni a sus filiales.',
  },
  nl: {
    subject: (b) => `Je garantie van 12 maanden is geactiveerd – ${b}`,
    heading: 'Garantie geactiveerd!',
    intro: 'Bedankt voor je aankoop. Je garantieverlenging van 12 maanden is nu actief.',
    orderLabel: 'Bestelnummer (laatste 4 cijfers)',
    keep: 'Bewaar deze e-mail als bewijs van je garantie.',
    help: 'Vragen over compatibiliteit of een defect? Antwoord gewoon op deze e-mail.',
    footer: 'Deze e-mail is verzonden in het kader van je garantieregistratie. Deze website is niet gelieerd aan Amazon.com, Inc. of haar dochterondernemingen.',
  },
  en: {
    subject: (b) => `Your 12-month warranty is activated – ${b}`,
    heading: 'Warranty activated!',
    intro: 'Thank you for your purchase. Your 12-month warranty extension is active as of now.',
    orderLabel: 'Order number (last 4 digits)',
    keep: 'Keep this email as proof of your warranty.',
    help: 'Questions about compatibility or a defect? Simply reply to this email.',
    footer: 'This email was sent as part of your warranty registration. This website is not affiliated with Amazon.com, Inc. or its subsidiaries.',
  },
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Build a localized confirmation email.
 *
 * @param {string} lang      one of de/fr/it/es/nl/en (falls back to de)
 * @param {object} opts      { brandName, supportEmail, orderSuffix }
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildEmail(lang, opts = {}) {
  const t = TEMPLATES[lang] || TEMPLATES.de;
  const brand = escapeHtml(opts.brandName || 'YourBrand');
  const support = escapeHtml(opts.supportEmail || '');
  const suffix = escapeHtml(opts.orderSuffix || '');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f7f5f0;font-family:-apple-system,Helvetica Neue,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;">
    <tr><td style="background:#1a2e4a;padding:22px 24px;text-align:center;">
      <div style="font-size:16px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ffffff;">${brand}</div>
    </td></tr>
    <tr><td style="padding:28px 24px 8px;text-align:center;">
      <div style="width:52px;height:52px;line-height:52px;border-radius:50%;background:#e8f5ee;color:#2d7a4f;font-size:24px;font-weight:700;margin:0 auto 16px;">&#10003;</div>
      <h1 style="margin:0 0 10px;font-size:21px;font-weight:600;">${t.heading}</h1>
      <p style="margin:0;font-size:14px;line-height:1.65;color:#6b6560;">${t.intro}</p>
    </td></tr>
    <tr><td style="padding:18px 24px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f5f0;border-radius:8px;">
        <tr><td style="padding:14px 16px;font-size:13px;color:#6b6560;">${t.orderLabel}</td>
            <td style="padding:14px 16px;font-size:15px;font-weight:700;text-align:right;color:#1a2e4a;letter-spacing:2px;">${suffix}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px 0;font-size:13px;line-height:1.65;color:#6b6560;">${t.keep}</td></tr>
    <tr><td style="padding:8px 24px 0;font-size:13px;line-height:1.65;color:#6b6560;">${t.help}${support ? ` <a href="mailto:${support}" style="color:#1a2e4a;">${support}</a>` : ''}</td></tr>
    <tr><td style="padding:22px 24px 26px;font-size:11px;line-height:1.6;color:#9a958f;">${t.footer}</td></tr>
  </table>
</body></html>`;

  const text = [
    t.heading,
    '',
    t.intro,
    `${t.orderLabel}: ${opts.orderSuffix || ''}`,
    '',
    t.keep,
    `${t.help}${opts.supportEmail ? ' ' + opts.supportEmail : ''}`,
    '',
    t.footer,
  ].join('\n');

  return { subject: t.subject(opts.brandName || 'YourBrand'), html, text };
}
