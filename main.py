import os
import psycopg2
from starkerak import StarKerakClient

# 1. Bazaga ulanish
conn = psycopg2.connect(os.environ['DATABASE_URL'], sslmode='require')
cur = conn.cursor()

# 2. Yangi API kalit bilan Clientni ishga tushirish
client = StarKerakClient("yWjGEHOYemUolmXfTvG03j0Va34qooeKxN4wMpdzu-U") 

# 3. To'lov kelganda ishlaydigan funksiya
@client.on_payment
async def pull_keldi(payment):
    print("Yangi to'lov qabul qilindi:", payment)
    
    amount = payment.get('amount')
    # Starkerak tizimida izoh (comment) odatda 'comment' yoki 'description' bo'ladi
    user_id = payment.get('comment') 
    
    if user_id:
        try:
            cur.execute("UPDATE users SET balance = balance + %s WHERE id = %s", (amount, user_id))
            conn.commit()
            print(f"Balans {user_id} uchun {amount} so'mga oshirildi!")
        except Exception as e:
            print(f"Baza xatosi: {e}")

# 4. Tinglashni boshlash
client.start_listening()