import os
import psycopg2
from starkerak import StarKerakClient

# Bazaga ulanish
conn = psycopg2.connect(os.environ['DATABASE_URL'], sslmode='require')
cur = conn.cursor()

# API Kalitini yozing
client = StarKerakClient("yWjGEHOYemUolmXfTvG03j0Va34qooeKxN4wMpdzu-U")

@client.on_payment
async def pull_keldi(payment):
    # Dastlab barcha ma'lumotni ko'raylik, nimalar kelayotganini bilish uchun
    print(f"DEBUG: To'lov ma'lumotlari: {payment}")
    
    amount = payment.get('amount')
    # Starkerak hujjatiga ko'ra izoh (comment) qaysi kalitda kelishini aniqlaymiz.
    # Agar 'comment' bo'lmasa, 'card_last' yoki boshqasini sinab ko'ramiz
    user_id = payment.get('comment') 
    
    if user_id:
        try:
            cur.execute("UPDATE users SET balance = balance + %s WHERE id = %s", (amount, user_id))
            conn.commit()
            print(f"Balans {user_id} uchun {amount} ga oshdi!")
        except Exception as e:
            print(f"Baza xatosi: {e}")

print("Bot ishga tushdi va Starkerakni tinglamoqda...")
client.start_listening()