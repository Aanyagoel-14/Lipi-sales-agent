# WordPress and WooCommerce

Read [`../api.md`](../api.md) first for authentication, pagination and the error envelope.

WordPress is PHP on your own server, which is the easy case: the key never reaches a browser.

## Settings

Store the key with the rest of your options and never print it into a page.

```php
// In your plugin's settings page
register_setting('lipi', 'lipi_api_key');
register_setting('lipi', 'lipi_url');
```

## One helper for every call

```php
function lipi_request($method, $path, $body = null) {
    $args = [
        'method'  => $method,
        'timeout' => 15,
        'headers' => [
            'Authorization' => 'Bearer ' . get_option('lipi_api_key'),
            'Content-Type'  => 'application/json',
        ],
    ];
    if ($body !== null) {
        $args['body'] = wp_json_encode($body);
    }

    $res = wp_remote_request(rtrim(get_option('lipi_url'), '/') . $path, $args);
    if (is_wp_error($res)) {
        return $res;
    }

    $decoded = json_decode(wp_remote_retrieve_body($res), true);
    $status  = wp_remote_retrieve_response_code($res);

    // One envelope at every status, so one branch handles every failure.
    if ($status >= 400) {
        return new WP_Error('lipi', $decoded['error'] ?? 'Unknown error', $decoded['details'] ?? null);
    }

    return $decoded;
}
```

## The chat endpoint

Expose your own REST route so the browser never sees the key.

```php
add_action('rest_api_init', function () {
    register_rest_route('lipi/v1', '/chat', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function (WP_REST_Request $req) {
            $result = lipi_request('POST', '/v1/conversations', [
                'channel' => 'webchat',
                'handle'  => sanitize_text_field($req['visitor_id']),
                'text'    => sanitize_textarea_field($req['text']),
            ]);
            if (is_wp_error($result)) {
                return $result;
            }
            return ['reply' => $result['reply']];
        },
    ]);
});
```

`visitor_id` is your stable identifier for the person. A logged-in user's email is the best one
you have; for an anonymous visitor, generate a uuid and keep it in `localStorage`.

## WooCommerce

### Tell Lipi what happened on your side

```php
add_action('woocommerce_thankyou', function ($order_id) {
    $order = wc_get_order($order_id);
    lipi_request('POST', '/v1/events', [
        'type'    => 'checkout.completed',
        'twin'    => 'order',
        'payload' => sprintf('woo=%d total=%s', $order_id, $order->get_total()),
    ]);
});
```

The event is stored as `external.checkout.completed` — the `external.` prefix is added for you,
so nothing you post can be mistaken for something Lipi's own ingest path observed. Events are
append-only: there is no update and no delete, which is what makes the log evidence.

### Read conversions back

```php
$conversions = lipi_request('GET', '/v1/conversions?stage=Paid&stage=Shipped');
foreach ($conversions['conversions'] as $c) {
    // valuePaise is exact. valueInr is rounded for display — do not sum it.
    $revenue_paise += $c['valuePaise'];
    $campaign = $c['attribution']['utmCampaign'] ?? 'direct';
}
```

## Paging a list

```php
function lipi_all($path, $key) {
    $rows = [];
    $cursor = null;
    do {
        $page = lipi_request('GET', $path . '?limit=200' . ($cursor ? '&cursor=' . rawurlencode($cursor) : ''));
        if (is_wp_error($page)) {
            return $page;
        }
        $rows = array_merge($rows, $page[$key]);
        $cursor = $page['nextCursor'];
    } while ($cursor !== null);

    return $rows;
}

$customers = lipi_all('/v1/customers', 'customers');
```

## Rate limits

600 requests a minute per key. A `429` carries `Retry-After` in seconds — honour it rather than
retrying immediately, and do bulk work on `wp_schedule_event` rather than in a page request.

## Front-end chat without a key

If you would rather not proxy at all, embed the widget: `/v1/webchat/{workspaceId}/session` and
`/message` need no key and accept any origin, exactly like an Intercom snippet. The workspace id
is meant to be public; a `lipi_sk_…` is not, and must never be printed into a page.
