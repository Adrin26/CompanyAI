import sqlite3
import jwt
from datetime import datetime, timedelta
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import OAuth2PasswordBearer
from redis import Redis

# SQLite setup for permanent credential storage
conn = sqlite3.connect("antigravity_data.db", check_same_thread=False)
cursor = conn.cursor()
cursor.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        hashed_password TEXT NOT NULL
    )
''')
# Create a dummy user for testing if they don't exist
cursor.execute("SELECT * FROM users WHERE username='admin'")
if not cursor.fetchone():
    from passlib.context import CryptContext
    pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
    cursor.execute(
        "INSERT INTO users (username, hashed_password) VALUES (?, ?)", 
        ("admin", pwd_context.hash("password123"))
    )
conn.commit()

# Redis session setup for fast token validation
redis_client = Redis(host='localhost', port=6379, db=1, decode_responses=True)

# Security config
SECRET_KEY = "super-secret-key-for-now"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)):
    # 1. Fast-path: Check Redis cache first to offload read strain from SQLite
    cached_user = redis_client.get(f"session:{token}")
    if cached_user:
        return cached_user
        
    # 2. Slow-path: Verify token and check SQLite database
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception
        
    cursor.execute("SELECT username FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()
    if user is None:
        raise credentials_exception
        
    # 3. Cache the validated session in Redis for future requests
    redis_client.setex(f"session:{token}", 300, username)  # Cache for 5 mins
    return username
