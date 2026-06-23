<?php
/**
 * Plugin Name: Infinito.Nexus HTTP CA Trust
 * Description: Points the WordPress HTTP API at the OS CA bundle. WpOrg\Requests
 *              otherwise pins CURLOPT_CAINFO to WordPress's own bundled
 *              wp-includes/certificates/ca-bundle.crt and ignores the OS trust
 *              store and the CURL_CA_BUNDLE/SSL_CERT_FILE env vars, so
 *              server-side wp_remote_* calls (e.g. the OIDC token exchange to
 *              the self-signed internal Keycloak) fail with "cURL error 60".
 *              The OS bundle is populated with the internal root CA by the
 *              compose CA-injection wrapper.
 */

if (!defined('ABSPATH')) {
    exit;
}

add_filter('http_request_args', static function (array $args): array {
    $bundle = '/etc/ssl/certs/ca-certificates.crt';
    if (is_readable($bundle)) {
        $args['sslcertificates'] = $bundle;
    }
    return $args;
}, 10, 1);
