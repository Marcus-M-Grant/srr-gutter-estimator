<?php
/**
 * Lead notification: emails SRR when a customer downloads an estimate.
 *
 * Runs on the HostGator account (srrgutters.com/api/estimate-notify.php) using
 * PHP's own mail(), so there is no third-party form service, no API key and no
 * billing account - the same constraint as the rest of the site.
 *
 * Posted to by src/notify.js, form-encoded. Every customer field is optional.
 *
 * Abuse protection, in order: POST only, origin allowlist, honeypot field,
 * length caps, header-injection stripping, and a per-IP hourly limit.
 *
 * Add ?dry=1 to get back the email that WOULD be sent, without sending it.
 */

// Both on the To line, so each can see the other has the lead.
const RECIPIENTS = [
    'marcus@specialistroofing.com',
    'scheduling@specialistroofing.com',
];
// Must be an address on this hosting account's own domain, or receiving mail
// servers treat the message as spoofed and spam-folder it.
const SENDER = 'estimates@srrgutters.com';
const SENDER_NAME = 'SRR Gutter Estimator';

const ALLOWED_ORIGINS = [
    'https://srrgutters.com',
    'https://www.srrgutters.com',
    'https://marcusmgrant.com',
];
const MAX_PER_HOUR = 20;

// HostGator's servers run on Central time; SRR is in Southern California.
date_default_timezone_set('America/Los_Angeles');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}

function reply(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') reply(204, []);
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') reply(405, ['ok' => false, 'error' => 'POST only']);

// Browsers always send Origin on a cross-site or keepalive POST. A missing or
// foreign origin is a script, not a customer.
if (!in_array($origin, ALLOWED_ORIGINS, true)) reply(403, ['ok' => false, 'error' => 'origin']);

/** One line of plain text: no CR/LF (header injection), no control chars, capped. */
function field(string $key, int $max): string {
    $v = (string)($_POST[$key] ?? '');
    $v = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $v);
    $v = trim(preg_replace('/\s+/u', ' ', $v));
    return mb_substr($v, 0, $max);
}

// Honeypot: a hidden field real people never see. Pretend it worked.
if (field('website', 200) !== '') reply(200, ['ok' => true]);

$lead = [
    'name'    => field('name', 100),
    'phone'   => field('phone', 40),
    'email'   => field('email', 200),
    'address' => field('address', 300),
    'total'   => field('total', 40),
    'range'   => field('range', 80),
    'job'     => field('job', 300),
    'color'   => field('color', 40),
    'warranty' => field('warranty', 3),
    'page'    => field('page', 200),
];
if ($lead['total'] === '') reply(400, ['ok' => false, 'error' => 'no estimate']);

$emailValid = $lead['email'] !== '' && filter_var($lead['email'], FILTER_VALIDATE_EMAIL);
$dry = isset($_GET['dry']);

// Per-IP hourly limit, kept in the system temp dir. Not bulletproof, just
// enough that a stuck script or a bored visitor cannot flood the inbox.
if (!$dry) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = sys_get_temp_dir() . '/srr-notify-' . hash('sha256', $ip . date('YmdH'));
    $count = (int)@file_get_contents($file);
    if ($count >= MAX_PER_HOUR) reply(429, ['ok' => false, 'error' => 'rate limited']);
    @file_put_contents($file, (string)($count + 1), LOCK_EX);
}

$or = fn(string $v) => $v !== '' ? $v : '(not given)';
$who = $lead['name'] !== '' ? $lead['name']
     : ($lead['phone'] !== '' ? $lead['phone']
     : ($lead['email'] !== '' ? $lead['email'] : 'No contact details'));

$subject = 'New gutter estimate: ' . $who . ' - ' . $lead['total'];

$body = implode("\n", [
    'Someone just downloaded a gutter estimate from the website.',
    '',
    'Name:     ' . $or($lead['name']),
    'Phone:    ' . $or($lead['phone']),
    'Email:    ' . $or($lead['email']),
    'Address:  ' . $or($lead['address']),
    '',
    'Estimate: ' . $lead['total'] . ($lead['range'] !== '' ? '  (range ' . $lead['range'] . ')' : ''),
    'Job:      ' . $or($lead['job']),
    'Color:    ' . ($lead['color'] !== '' ? $lead['color'] : '(not chosen)'),
    'Warranty: ' . ($lead['warranty'] === 'yes'
        ? 'Qualifies for the free 10-year warranty'
        : 'Did not qualify (no name plus phone or email)'),
    '',
    'Sent ' . date('l, F j, Y g:i A T') . ' from ' . $or($lead['page']),
    ($lead['name'] . $lead['phone'] . $lead['email']) === ''
        ? "\nThe customer left all contact fields blank."
        : '',
]);

$headers = [
    'From: ' . SENDER_NAME . ' <' . SENDER . '>',
    'Content-Type: text/plain; charset=UTF-8',
    'X-Mailer: srrgutters.com',
];
// Hitting Reply goes straight to the customer when they gave an email.
if ($emailValid) {
    $replyName = $lead['name'] !== '' ? '"' . str_replace('"', '', $lead['name']) . '" ' : '';
    $headers[] = 'Reply-To: ' . $replyName . '<' . $lead['email'] . '>';
}

if ($dry) {
    reply(200, ['ok' => true, 'dry' => true, 'to' => RECIPIENTS,
        'subject' => $subject, 'headers' => $headers, 'body' => $body]);
}

$sent = mail(implode(', ', RECIPIENTS), '=?UTF-8?B?' . base64_encode($subject) . '?=', $body,
    implode("\r\n", $headers), '-f' . SENDER);

reply($sent ? 200 : 500, ['ok' => (bool)$sent]);
