import os
import psycopg2
from starkerak import StarKerakClient

# 1. Bazaga ulanishni tekshiramiz
try:
    DATABASE_URL = os.environ['DATABASE_URL']
    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    cur = conn.cursor()
    print("Baza bilan ulanish muvaffaqiyatli!")
except Exception as e:
    print(f"BAZA XATOLIGI: {e}")

# 2. Client
client = StarKerakClient("7bshDqG6hefSUpewpPcL8jmu4uOcK27jtAL1sSfHks") 

@client.on_payment
async def pull_keldi(payment):
    print(f"To'lov qabul qilindi: {payment}") # Har qanday to'lovni ko'rish uchun
    amount = payment.get('amount')
    user_id = payment.get('comment', '0')
    
    try:
        cur.execute("UPDATE users SET balance = balance + %s WHERE id = %s", (amount, user_id))
        conn.commit()
        print(f"Balans {user_id} uchun {amount} ga oshdi!")
    except Exception as e:
        print(f"BAZA YANGILASH XATOLIGI: {e}")

print("Bot ishga tushdi va to'lovlarni kutmoqda...")
client.start_listening()