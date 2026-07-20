"""
integration_example.py
========================
Shop botingiz (masalan aiogram/python-telegram-bot bilan yozilgan asosiy bot)
va gift_sender.py (userbot) o'rtasida bog'lanishni ko'rsatuvchi ODDIY misol.

Ikkala jarayon (asosiy bot va userbot) alohida ishlaydi. Ular orasidagi
aloqa uchun eng oddiy yo'l -- umumiy JSON navbat fayli (yoki xohlasangiz
Redis/DB navbati bilan almashtirishingiz mumkin).

OQIM:
1) Mijoz mini-app orqali xarid qiladi -> asosiy shop bot backendi
   "gift_queue.json" fayliga yozuv qo'shadi (append_gift_order).
2) userbot (gift_sender.py) alohida jarayon sifatida navbatni har necha
   soniyada bir tekshiradi va yangi buyurtmalarni yuboradi
   (watch_queue_and_send).
"""

import asyncio
import json
import os
from pathlib import Path

from gift_sender import GiftSender, API_ID, API_HASH, SESSION_NAME

QUEUE_FILE = Path("gift_queue.json")
POLL_INTERVAL = 10  # soniya


# ------------------------------------------------------------------
# ASOSIY SHOP BOT TOMONIDA CHAQIRILADIGAN FUNKSIYA
# ------------------------------------------------------------------
def append_gift_order(
    user: str,
    gift_id: int,
    text: str = "",
    hide_my_name: bool = False,
):
    """
    Buni asosiy shop botingizning "xarid muvaffaqiyatli bo'ldi" logikasi
    ichida chaqiring, masalan:

        if payment.status == "success":
            append_gift_order(
                user=f"@{payment.username}",
                gift_id=CHEAPEST_GIFT_ID,
                text="Xaridingiz uchun rahmat!",   # sharh -- ixtiyoriy, bo'sh ham bo'lishi mumkin
                hide_my_name=False,                # True = anonim, False = ism ko'rinadi
            )

    hide_my_name:
        - False -> gift "Ism Familiya"dan kelgan sifatida ko'rinadi (odatiy)
        - True  -> gift anonim sifatida ko'rinadi, mijoz kimdan kelganini bilmaydi

    Bu qiymatni mini-app'da mijozning o'ziga (masalan xarid vaqtida
    "Sovg'ani anonim yuborish" degan checkbox orqali) yoki do'kon tomonidan
    belgilangan qat'iy qoidaga ko'ra tanlashingiz mumkin.
    """
    orders = []
    if QUEUE_FILE.exists():
        orders = json.loads(QUEUE_FILE.read_text() or "[]")
    orders.append({
        "user": user,
        "gift_id": gift_id,
        "text": text,
        "hide_my_name": hide_my_name,
        "sent": False,
    })
    QUEUE_FILE.write_text(json.dumps(orders, ensure_ascii=False, indent=2))


# ------------------------------------------------------------------
# USERBOT TOMONIDA ISHLAYDIGAN NAVBAT KUZATUVCHISI
# ------------------------------------------------------------------
async def watch_queue_and_send():
    sender = GiftSender(API_ID, API_HASH, SESSION_NAME)
    await sender.start()
    await sender.refresh_available_gifts()

    while True:
        if QUEUE_FILE.exists():
            orders = json.loads(QUEUE_FILE.read_text() or "[]")
            changed = False
            for order in orders:
                if order.get("sent"):
                    continue
                ok = await sender.send_gift(
                    user=order["user"],
                    gift_id=order["gift_id"],
                    text=order.get("text", ""),
                    hide_my_name=order.get("hide_my_name", False),
                )
                order["sent"] = ok
                changed = True
                await asyncio.sleep(5)  # yuborishlar orasida kutish

            if changed:
                QUEUE_FILE.write_text(json.dumps(orders, ensure_ascii=False, indent=2))

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(watch_queue_and_send())
