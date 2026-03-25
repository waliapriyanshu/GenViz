const { PrismaClient } = require('@prisma/client')
require('dotenv').config({ path: '.env.local' })
const prisma = new PrismaClient()


async function main() {
  await prisma.data.createMany({
    data: [
      { product: 'Laptop', category: 'Electronics', revenue: 125000, quantity: 50, region: 'North' },
      { product: 'Phone', category: 'Electronics', revenue: 89000, quantity: 120, region: 'South' },
      { product: 'Monitor', category: 'Electronics', revenue: 67000, quantity: 45, region: 'East' },
      { product: 'Headphones', category: 'Electronics', revenue: 23000, quantity: 200, region: 'West' },
      { product: 'Chair', category: 'Furniture', revenue: 28000, quantity: 150, region: 'North' },
      { product: 'Desk', category: 'Furniture', revenue: 32000, quantity: 40, region: 'South' },
      { product: 'Keyboard', category: 'Electronics', revenue: 12000, quantity: 180, region: 'East' },
    ],
  })
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
