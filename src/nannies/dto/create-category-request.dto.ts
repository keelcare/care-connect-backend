import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class CreateCategoryRequestDto {
    @IsArray()
    @IsString({ each: true })
    @ArrayMinSize(1, { message: 'At least one category is required' })
    categories: string[];
}
