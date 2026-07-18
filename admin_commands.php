<?php
function handleAdminCommands(int $chatId, string $text): bool {
    // /setprice NARX
    if (preg_match('/^\/setprice\s+(\d+)/', $text, $m)) {
        setSetting('stars_price_uzs', $m[1]);
        sendMessage($chatId, "✅ 1 Stars narxi: <b>{$m[1]} so'm</b> qilib belgilandi.");
        return true;
    }
    // /setmin MIN
    if (preg_match('/^\/setmin\s+(\d+)/', $text, $m)) {
        setSetting('min_stars', $m[1]);
        sendMessage($chatId, "✅ Minimum Stars: <b>{$m[1]}</b>");
        return true;
    }
    // /setmax MAX
    if (preg_match('/^\/setmax\s+(\d+)/', $text, $m)) {
        setSetting('max_stars', $m[1]);
        sendMessage($chatId, "✅ Maksimum Stars: <b>{$m[1]}</b>");
        return true;
    }
    // /setchannel @kanal_username yoki -100xxxx
    if (preg_match('/^\/setchannel\s+(\S+)/', $text, $m)) {
        $channel = $m[1];
        setSetting('force_sub_channel', $channel);
        sendMessage($chatId, "✅ Majburiy obuna kanali o'rnatildi: <b>{$channel}</b>\n\n⚠️ Diqqat: botni shu kanalga <b>admin</b> qilib qo'shganingizga ishonch hosil qiling, aks holda tekshiruv ishlamaydi.");
        return true;
    }
    // /removechannel
    if ($text === '/removechannel') {
        setSetting('force_sub_channel', '');
        sendMessage($chatId, "✅ Majburiy obuna o'chirildi.");
        return true;
    }
    // /addbal USER_ID SUMMA
    if (preg_match('/^\/addbal\s+(\d+)\s+(\d+(?:\.\d+)?)/', $text, $m)) {
        addBalance((int)$m[1], (float)$m[2]);
        sendMessage($chatId, "✅ Foydalanuvchi <code>{$m[1]}</code> ga <b>{$m[2]} so'm</b> qo'shildi.");
        return true;
    }
    // /broadcast MATN
    if (preg_match('/^\/broadcast\s+(.+)/s', $text, $m)) {
        $stmt  = getDB()->query("SELECT telegram_id FROM users");
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $count = 0;
        foreach ($users as $u) {
            $res = sendMessage((int)$u['telegram_id'], $m[1]);
            if (isset($res['ok']) && $res['ok'] === true) $count++;
            usleep(50000); // spam limitdan qochish
        }
        sendMessage($chatId, "📢 Xabar <b>{$count}</b> ta foydalanuvchiga yuborildi.");
        return true;
    }
    // /setfragmentkey KEY
    if (preg_match('/^\/setfragmentkey\s+(\S+)/', $text, $m)) {
        setSetting('fragment_api_key', $m[1]);
        sendMessage($chatId, "✅ fragment-api.uz kaliti saqlandi:\n<code>{$m[1]}</code>\n\n⚠️ Jonli ishga tushirishdan oldin: fragment-api.uz kabinetingizda hamyon balansi (TON/USDT) yetarli ekanini tekshiring, so'ng o'zingizning Telegram akkauntingizda 3 oylik Premium bilan bitta sinov buyurtma bering.");
        return true;
    }
    // /setpremiumprice OY NARX  (masalan: /setpremiumprice 3 250000)
    if (preg_match('/^\/setpremiumprice\s+(3|6|12)\s+(\d+)/', $text, $m)) {
        setSetting('premium_price_' . $m[1], $m[2]);
        sendMessage($chatId, "✅ {$m[1]} oylik Premium narxi: <b>{$m[2]} so'm</b> qilib belgilandi.");
        return true;
    }
    // /admin
    if ($text === '/admin') {
        showAdminPanel($chatId);
        return true;
    }
    return false;
}

function showAdminPanel(int $chatId): void {
    $users   = getUsersCount();
    $stats   = getOrdersStats();
    $price   = getSetting('stars_price_uzs');
    $min     = getSetting('min_stars');
    $max     = getSetting('max_stars');
    $channel = getSetting('force_sub_channel');
    $channelText = !empty($channel) ? $channel : '<i>o\'rnatilmagan</i>';

    $fragmentKey    = getSetting('fragment_api_key');
    $fragmentStatus = !empty($fragmentKey) ? "sozlangan ✅" : "<i>sozlanmagan</i>";
    $p3  = getSetting('premium_price_3');
    $p6  = getSetting('premium_price_6');
    $p12 = getSetting('premium_price_12');

    $text = "🔧 <b>Admin Panel</b>\n\n"
          . "👥 Foydalanuvchilar: <b>{$users}</b>\n"
          . "📦 Bajarilgan buyurtmalar: <b>{$stats['cnt']}</b>\n"
          . "💰 Jami daromad: <b>" . number_format($stats['total'], 0, '.', ' ') . " so'm</b>\n\n"
          . "💲 1 Stars narxi: <b>{$price} so'm</b>\n"
          . "⭐ Min: <b>{$min}</b> | Max: <b>{$max}</b>\n\n"
          . "🔑 fragment-api.uz kaliti: {$fragmentStatus}\n"
          . "💎 Premium narxlari: 3oy-<b>{$p3}</b> | 6oy-<b>{$p6}</b> | 12oy-<b>{$p12}</b> so'm\n\n"
          . "📢 Majburiy obuna: {$channelText}\n\n"
          . "<b>Buyruqlar:</b>\n"
          . "/setprice <code>NARX</code> — Stars narxini o'zgartirish\n"
          . "/setmin <code>MIN</code> — Minimum miqdor\n"
          . "/setmax <code>MAX</code> — Maksimum miqdor\n"
          . "/setfragmentkey <code>KALIT</code> — fragment-api.uz kalitini kiritish\n"
          . "/setpremiumprice <code>OY NARX</code> — masalan: /setpremiumprice 3 250000\n"
          . "/setchannel <code>@kanal</code> — Majburiy obuna kanalini o'rnatish\n"
          . "/removechannel — Majburiy obunani o'chirish\n"
          . "/addbal <code>USER_ID SUMMA</code> — Balans qo'shish\n"
          . "/broadcast <code>MATN</code> — Barcha foydalanuvchilarga xabar";

    sendMessage($chatId, $text);
}
