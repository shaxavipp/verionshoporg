"""
gift_sender.py
================
Shaxsiy Telegram akkauntingizdan (userbot) mijozlarga "oddiy" (regular) gift
yuborish uchun modul. Shu akkaunt orqali yuborilgani uchun, qabul qiluvchi
gift'ni keyinchalik Stars'ga aylantira oladi (bot orqali yuborilgan
sendGift'dan farqli o'laroq).

MUHIM ESLATMA (xavflar haqida):
- Bu shaxsiy akkauntni avtomatlashtiradi (userbot). Telegram bunday
  avtomatlashtirishni ToS bo'yicha cheklashi mumkin -> akkaunt vaqtincha
  cheklanishi yoki bloklanishi ehtimoli bor.
- session faylini (gift_sender.session) hech kimga bermang -- u orqali
  akkauntingizga to'liq kirish mumkin.
- Ishlab chiqarishga (production) qo'yishdan oldin albatta ozgina hajmda
  sinab ko'ring va so'rovlar orasiga kechikish (delay) qo'shing.

Talab qilinadigan kutubxona:
    pip install telethon --break-system-packages

api_id / api_hash olish uchun: https://my.telegram.org -> API Development
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional, Union

from telethon import TelegramClient, functions, types
from telethon.errors import FloodWaitError, RPCError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("gift_sender")

# ------------------------------------------------------------------
# SOZLAMALAR -- bu qiymatlarni o'zingiznikiga almashtiring
# ------------------------------------------------------------------
API_ID = 39890698                     # my.telegram.org dan olingan api_id
API_HASH = "5016d26ec75fabe48880db4f808e4379"     # my.telegram.org dan olingan api_hash
SESSION_NAME = "gift_sender"        # session fayli nomi (gift_sender.session yaratiladi)

# Ketma-ket gift yuborishlar orasidagi minimal kutish vaqti (soniyada).
# Bu akkauntni spam sifatida belgilanish xavfini kamaytirishga yordam beradi.
MIN_DELAY_BETWEEN_GIFTS = 5.0


@dataclass
class GiftOption:
    id: int
    stars: int
    limited: bool
    sold_out: bool


class GiftSender:
    def __init__(self, api_id: int, api_hash: str, session_name: str):
        self.client = TelegramClient(session_name, api_id, api_hash)
        self._gifts_cache: list[GiftOption] = []

    async def start(self):
        """Birinchi marta ishga tushirganda telefon raqami va SMS/2FA kodini so'raydi."""
        await self.client.start()
        me = await self.client.get_me()
        log.info(f"Ulanildi: {me.first_name} (@{me.username}) — id={me.id}")

    async def stop(self):
        await self.client.disconnect()

    # ----------------------------------------------------------------
    # 1) Mavjud gift'lar ro'yxatini olish
    # ----------------------------------------------------------------
    async def refresh_available_gifts(self) -> list[GiftOption]:
        """Sotib olish mumkin bo'lgan barcha gift'larni yangilaydi va qaytaradi."""
        result = await self.client(functions.payments.GetStarGiftsRequest(hash=0))
        gifts = []
        for g in result.gifts:
            # Faqat oddiy (regular) StarGift obyektlarini olamiz, unique emas
            if isinstance(g, types.StarGift):
                gifts.append(
                    GiftOption(
                        id=g.id,
                        stars=g.stars,
                        limited=bool(g.limited),
                        sold_out=bool(getattr(g, "sold_out", False)),
                    )
                )
        self._gifts_cache = gifts
        log.info(f"{len(gifts)} ta gift turi topildi")
        return gifts

    def cheapest_available_gift(self) -> Optional[GiftOption]:
        """Eng arzon, hali sotib olsa bo'ladigan (sold_out=False) gift'ni qaytaradi."""
        available = [g for g in self._gifts_cache if not g.sold_out]
        if not available:
            return None
        return min(available, key=lambda g: g.stars)

    # ----------------------------------------------------------------
    # 2) Gift yuborish (asosiy funksiya)
    # ----------------------------------------------------------------
    async def send_gift(
        self,
        user: Union[str, int],
        gift_id: int,
        text: str = "",
        hide_my_name: bool = False,
    ) -> bool:
        """
        Berilgan foydalanuvchiga (username yoki user_id) gift yuboradi.
        Muvaffaqiyatli bo'lsa True qaytaradi.

        user: '@username' yoki raqamli user_id (avval client bilan bir marta
              muloqotda bo'lgan / kontaktlarda bo'lgan foydalanuvchi bo'lishi kerak,
              aks holda Telethon uni "peer" sifatida topa olmasligi mumkin).
        gift_id: refresh_available_gifts() orqali olingan GiftOption.id
        text: gift bilan birga yuboriladigan matn (ixtiyoriy)
        """
        try:
            peer = await self.client.get_input_entity(user)
        except ValueError:
            log.error(f"Foydalanuvchi topilmadi: {user}. "
                      f"Avval u botga/akkauntga yozgan bo'lishi kerak.")
            return False

        invoice = types.InputInvoiceStarGift(
            peer=peer,
            gift_id=gift_id,
            hide_name=hide_my_name,
            message=types.TextWithEntities(text=text, entities=[]) if text else None,
        )

        try:
            # 1-qadam: to'lov formasini olish
            form = await self.client(functions.payments.GetPaymentFormRequest(invoice=invoice))

            # 2-qadam: Stars balansidan to'lovni amalga oshirish
            result = await self.client(
                functions.payments.SendStarsFormRequest(
                    form_id=form.form_id,
                    invoice=invoice,
                )
            )
            log.info(f"Gift muvaffaqiyatli yuborildi -> {user} (gift_id={gift_id})")
            return True

        except FloodWaitError as e:
            log.warning(f"FloodWait: {e.seconds} soniya kutish kerak. Bu safar o'tkazib yuborildi.")
            return False
        except RPCError as e:
            log.error(f"Gift yuborishda xatolik ({user}): {e}")
            return False

    # ----------------------------------------------------------------
    # 3) Navbat (queue) orqali bir nechta gift yuborish, delay bilan
    # ----------------------------------------------------------------
    async def process_queue(self, orders: list[dict]):
        """
        orders: [{"user": "@username", "gift_id": 123, "text": "Rahmat!", "hide_my_name": False}]
        ko'rinishidagi ro'yxat. Har bir yuborishdan keyin MIN_DELAY_BETWEEN_GIFTS
        soniya kutadi.
        """
        for order in orders:
            ok = await self.send_gift(
                user=order["user"],
                gift_id=order["gift_id"],
                text=order.get("text", ""),
                hide_my_name=order.get("hide_my_name", False),
            )
            if not ok:
                log.warning(f"O'tkazib yuborildi: {order}")
            await asyncio.sleep(MIN_DELAY_BETWEEN_GIFTS)


# ----------------------------------------------------------------
# Sinov uchun mustaqil ishga tushirish
# ----------------------------------------------------------------
async def main():
    sender = GiftSender(API_ID, API_HASH, SESSION_NAME)
    await sender.start()

    await sender.refresh_available_gifts()
    cheapest = sender.cheapest_available_gift()
    if cheapest:
        log.info(f"Eng arzon gift: id={cheapest.id}, narxi={cheapest.stars} Stars")

    # MISOL: bitta mijozga gift yuborish (o'zingiznikiga almashtiring)
    # await sender.send_gift(user="@some_customer", gift_id=cheapest.id, text="Xaridingiz uchun rahmat!")

    await sender.stop()


if __name__ == "__main__":
    asyncio.run(main())
